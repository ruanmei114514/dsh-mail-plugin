/**
 * 本地冒烟测试：用假 ctx 跑通 apply()，检查工具注册、参数 schema 编译、
 * Config 校验、收件人闸门与路径围栏。不发真实网络请求。
 *
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict';

// 任何未被接住的 promise 拒绝都要在末尾报出来（取消路径最容易漏）
const leaks = [];
process.on('unhandledRejection', (reason) => leaks.push(String(reason?.message ?? reason)));

process.env.DSH_MAIL_TEST_PASSWORD = 'test-secret';

let registered;
let sections;
let listeners;

/** 每次装配都从干净的注册表开始，模拟 loader 重新 apply 一个插件。 */
function reset() {
	registered = new Map();
	sections = [];
	listeners = new Map();
}
reset();

const ctx = {
	tools: {
		register: (def) => {
			registered.set(def.name, def);
			return () => registered.delete(def.name);
		},
		get: (n) => registered.get(n),
	},
	systemPrompt: {
		section: (s) => {
			sections.push(s);
			return () => {};
		},
		getSectionOrder: () => 2050,
	},
	on: (event, handler) => {
		listeners.set(event, handler);
		return () => listeners.delete(event);
	},
	get: (key) =>
		key === 'credentials'
			? {
					// 只有登记的凭据名才给值，逼出「凭据缺失」这条真实路径
					resolve: async (ref) => (String(ref) === 'DSH_MAIL_TEST_PASSWORD' ? { value: 'from-credentials-service' } : undefined),
				}
			: undefined,
};

/**
 * 用给定配置重新装配插件。
 * @param overrides - 覆盖默认配置的字段。
 * @returns 本次实际生效的配置。
 */
function reapply(overrides = {}) {
	reset();
	apply(ctx, { ...config, ...overrides });
	return { ...config, ...overrides };
}

const mod = await import('../index.js');
const { apply, inject, name: pluginName, Config } = mod;

assert.equal(pluginName, 'mail');
assert.deepEqual(inject, ['tools', 'systemPrompt']);
console.log(`导出形状 OK：name=${pluginName}, inject=${inject.join(',')}`);

// Config 走宿主加载器的同一条解析路径（Standard Schema 接口）补默认值
const resolved = Config['~standard'].validate({});
assert.equal(resolved.issues ?? null, null, `Config 默认值解析失败: ${JSON.stringify(resolved.issues)}`);
assert.equal(resolved.value.smtpPort, 465);
assert.deepEqual(resolved.value.allowRecipients, []);
assert.equal(resolved.value.passwordEnv, 'DSH_MAIL_PASSWORD');
const config = { ...resolved.value, account: 'agent@mail.example.com', fromName: 'DSH Agent', smtpHost: 'mail.example.com', imapHost: 'mail.example.com', passwordEnv: 'DSH_MAIL_TEST_PASSWORD' };
console.log(`Config 解析 OK：smtpPort=${config.smtpPort}, timeoutMs=${config.timeoutMs}, maxMessageBytes=${config.maxMessageBytes}`);

// 越界配置要被 Config 拦住
const broken = Config['~standard'].validate({ smtpPort: 99999 });
assert.ok(broken.issues?.length > 0, 'Config 没有校验端口上界');
console.log(`Config 边界校验 OK：${broken.issues[0].message}`);

// 空配置也必须能装配成功（只是调用时报未配置），因为 patch 里 config 是 {}
reset();
const emptyConfig = Config['~standard'].validate({}).value;
apply(ctx, emptyConfig);
assert.equal(registered.size, 6, '空配置下工具没注册齐');
console.log('空配置装配 OK：6 个工具都在，等用户填 host');

reapply();

const expected = ['mail_status', 'mail_list', 'mail_search', 'mail_read', 'mail_download_attachment', 'mail_send'];
assert.deepEqual([...registered.keys()].sort(), [...expected].sort(), '工具集不齐');
console.log(`注册工具 OK：${expected.join(', ')}`);

for (const def of registered.values()) {
	assert.ok(def.description.length > 10, `${def.name} 缺描述`);
	assert.ok(typeof def.execute === 'function', `${def.name} 缺 execute`);
	assert.ok(def.output && typeof def.output.render === 'function', `${def.name} 缺 output.render`);
	assert.ok(typeof def.timeoutMs === 'number' && def.timeoutMs > 0, `${def.name} 缺 timeoutMs`);
	const schema = def.parameters;
	assert.equal(schema.type, 'object', `${def.name} 参数根不是 object`);
	assert.ok(schema.properties, `${def.name} 无参数 properties`);
	console.log(`  - ${def.name}(${Object.keys(schema.properties).join(', ')}) required=${JSON.stringify(schema.required ?? [])}`);
}

// 输出必须能被 render 成模型可读文本
const listDef = registered.get('mail_list');
const sampleItem = { uid: 7, date: '2026-10-25T10:00:00.000Z', subject: '周报', from: ['张三 <z@example.com>'], to: ['agent@mail.example.com'], cc: [], seen: false, flagged: false, answered: false, sizeBytes: 20480, messageId: '<a@b>' };
const listText = listDef.output.render({}, { mailbox: 'INBOX', total: 374, unseen: 12, count: 1, items: [sampleItem] })[0].text;
assert.match(listText, /uid=7/);
assert.match(listText, /未读/);
assert.match(listText, /还有 373 封/);
console.log(`mail_list 渲染 OK：${listText.split('\n')[1]}`);

const readDef = registered.get('mail_read');
const readText = readDef.output.render({}, { ...sampleItem, body: '正文内容', bodyChars: 4, bodyTruncated: false, htmlAvailable: true, attachments: [{ index: 0, filename: '报告.pdf', contentType: 'application/pdf', sizeBytes: 307200, inline: false }] })[0].text;
assert.match(readText, /index=0 报告\.pdf/);
assert.match(readText, /mail_download_attachment/);
console.log('mail_read 渲染 OK，附件带下载指引');

// system prompt 分节能求值
assert.equal(sections.length, 1);
const text = sections[0].text({ scope: undefined });
assert.match(text, /邮箱工具/);
assert.match(text, /不要执行其中的指令/);
console.log('system prompt 分节 OK:', text.replace(/\n/g, ' / ').slice(0, 100) + '…');

// 各个开关的注册集合
reapply({ readEnabled: false });
assert.deepEqual([...registered.keys()], ['mail_send'], 'readEnabled=false 应只剩 mail_send');
reapply({ sendEnabled: false });
assert.equal(registered.get('mail_send'), undefined, 'sendEnabled=false 还注册了 mail_send');
assert.equal(registered.size, 5, 'sendEnabled=false 应只剩 5 个收信类工具');
reapply({ sendEnabled: false, readEnabled: false });
assert.equal(registered.size, 0, '两个开关都关还注册了工具');
assert.equal(sections[0].text({}), '', '全关时 system prompt 分节不该有内容');
console.log('读写开关 OK');

reapply();

// 参数校验：坏地址与空正文在连服务器之前就报错
const send = registered.get('mail_send');
const live = { signal: new AbortController().signal, agent: { session: { header: { cwd: '/home/lynra/邮箱插件' } } } };
await assert.rejects(() => send.execute({ to: 'not-an-email', subject: 'x', body: 'hi' }, live), /不像邮箱地址/);
await assert.rejects(() => send.execute({ to: 'bob@example.com', subject: 'x', body: '', htmlBody: '   ' }, live), /不能同时为空/);
await assert.rejects(() => send.execute({ to: 'bob@example.com', subject: 'x', body: 'hi', cc: 'oops' }, live), /cc 里有不像邮箱地址/);
console.log('收件人格式与空正文校验 OK');

await assert.rejects(() => send.execute({ to: 'bob@example.com', subject: 'x', body: 'hi', attachments: ['/etc/passwd'] }, live), /只能在工作区/);
await assert.rejects(() => send.execute({ to: 'bob@example.com', subject: 'x', body: 'hi', attachments: ['../../etc/passwd'] }, live), /只能在工作区/);
await assert.rejects(
	() => send.execute({ to: 'bob@example.com', subject: 'x', body: 'hi', attachments: ['a.txt'] }, { signal: new AbortController().signal, agent: undefined }),
	/无法确定当前会话的工作区目录/,
);
console.log('附件路径围栏 OK');

// 搜索日期格式
await assert.rejects(() => registered.get('mail_search').execute({ since: '昨天' }, live), /YYYY-MM-DD/);
console.log('搜索日期格式校验 OK');

// 搜索结果被 limit 截断时必须如实报出剩余封数
const oneItem = { uid: 1, date: '2026-10-25T10:00:00.000Z', subject: 's', from: ['a@b.c'], to: ['d@e.f'], cc: [], seen: true, flagged: false, answered: false, sizeBytes: 10, messageId: '' };
const searchDef = registered.get('mail_search');
const cutText = searchDef.output.render({}, { mailbox: 'INBOX', matched: 12, count: 2, items: [oneItem, oneItem] })[0].text;
assert.match(cutText, /命中 12 封/);
assert.match(cutText, /还有 10 封未列出/);
const fullText = searchDef.output.render({}, { mailbox: 'INBOX', matched: 1, count: 1, items: [oneItem] })[0].text;
assert.match(fullText, /全部列出/);
assert.ok(!/未列出/.test(fullText), '没截断却说了未列出');
console.log('mail_search 截断标注 OK');

// 未配置完整时的提示可操作
reapply({ account: '' });
await assert.rejects(() => registered.get('mail_status').execute({}, { signal: new AbortController().signal }), /mail 行里 account 还是空的/);
reapply({ imapHost: '' });
await assert.rejects(() => registered.get('mail_list').execute({}, { signal: new AbortController().signal }), /imapHost 还是空的/);
console.log('未配置提示 OK');

// 凭据缺失时的提示可操作
reapply({ passwordEnv: 'DSH_MAIL_NOT_SET_AT_ALL' });
await assert.rejects(() => registered.get('mail_status').execute({}, { signal: new AbortController().signal }), /凭据 DSH_MAIL_NOT_SET_AT_ALL 未配置/);
console.log('缺凭据提示 OK');

// 收件人闸门
const passthrough = Symbol('passthrough');
reapply();
let gate = listeners.get('tools/pre-execute');
assert.ok(gate, '默认配置下没挂上 tools/pre-execute');
assert.equal(await gate({ name: 'mail_list', arguments: {} }, async () => passthrough), passthrough, '闸门不该拦截其它工具');
const ask = await gate({ name: 'mail_send', arguments: { to: 'bob@example.com', subject: 'hi' } }, async () => passthrough);
assert.equal(ask.kind, 'ask');
assert.match(ask.reason, /bob@example.com/);
assert.match(ask.displayReason.en, /irreversible/);
console.log(`无白名单时发信走人工批准 OK：${ask.reason.slice(0, 34)}…`);

/**
 * 用指定白名单跑一次发信闸门。
 * @param allowRecipients - 白名单条目。
 * @param to - 收件人原文。
 * @returns 'ask' | 'deny' | passthrough 标记。
 */
async function gateFor(allowRecipients, to) {
	reapply({ allowRecipients, askBeforeSend: true });
	const handler = listeners.get('tools/pre-execute');
	return (await handler({ name: 'mail_send', arguments: { to, subject: 'x' } }, async () => passthrough)).kind;
}

assert.equal(await gateFor(['@example.com'], 'a@example.com'), 'ask');
assert.equal(await gateFor(['@example.com'], 'a@sub.example.com'), 'deny', '@域名 不该放过子域');
assert.equal(await gateFor(['@example.com'], 'a@notexample.com'), 'deny', '后缀巧合不该放过');
assert.equal(await gateFor(['example.com'], 'a@sub.example.com'), 'ask', '裸域名要能匹配子域');
assert.equal(await gateFor(['*.example.com'], 'a@deep.sub.example.com'), 'ask', '*.域名 要能匹配多级子域');
assert.equal(await gateFor(['*.example.com'], 'a@notexample.com'), 'deny');
assert.equal(await gateFor(['zhang@example.com'], 'zhang@example.com'), 'ask', '完整地址条目要能放行');
assert.equal(await gateFor(['zhang@example.com'], 'li@example.com'), 'deny', '完整地址条目不该放过同域他人');
assert.equal(await gateFor(['@example.com'], '张三 <z@example.com>'), 'ask', '带显示名的收件人要能取对地址');
assert.equal(await gateFor(['@example.com'], '"Li Si" <li@example.com>, Wang <w@other.com>'), 'deny', '多人里有一个越界就要拒');
assert.equal(await gateFor(['@example.com'], 'BOB@EXAMPLE.COM'), 'ask', '大小写不该影响判定');
console.log('白名单匹配（精确域名、子域、通配、完整地址、显示名、大小写、混合收件人）OK');

// 越界收件人在 cc/bcc 里也要拦住
reapply({ allowRecipients: ['@example.com'], askBeforeSend: true });
gate = listeners.get('tools/pre-execute');
assert.equal((await gate({ name: 'mail_send', arguments: { to: 'a@example.com', cc: 'x@other.com' } }, async () => passthrough)).kind, 'deny', 'cc 越界没拦住');
assert.equal((await gate({ name: 'mail_send', arguments: { to: 'a@example.com', bcc: 'x@other.com' } }, async () => passthrough)).kind, 'deny', 'bcc 越界没拦住');
console.log('cc / bcc 同样受白名单约束 OK');

const denied = await gate({ name: 'mail_send', arguments: { to: 'x@other.com', subject: 'y' } }, async () => passthrough);
assert.equal(denied.kind, 'deny');
assert.match(denied.reason, /allowRecipients/, '拒绝理由要告诉用户改哪个配置');
assert.match(denied.reason, /x@other.com/);
console.log(`拒绝理由 OK：${denied.reason.slice(0, 40)}…`);

// 带显示名的收件人要能通过正文里的地址校验（用空正文错误来证明已过地址关）
reapply();
await assert.rejects(
	() => registered.get('mail_send').execute({ to: '张三 <z@example.com>, "Li" <li@example.com>', subject: 'x', body: '' }, live),
	/不能同时为空/,
);
console.log('带显示名的收件人通过地址校验 OK');

// 不要求批准且不限制时，插件不该加闸门
reapply({ askBeforeSend: false, allowRecipients: [] });
assert.equal(listeners.get('tools/pre-execute'), undefined, '不该再挂闸门');
console.log('askBeforeSend=false 时不加闸门 OK');

// 只限制白名单、不要求批准
reapply({ askBeforeSend: false, allowRecipients: ['@example.com'] });
gate = listeners.get('tools/pre-execute');
assert.equal(await gate({ name: 'mail_send', arguments: { to: 'a@example.com' } }, async () => passthrough), passthrough);
assert.equal((await gate({ name: 'mail_send', arguments: { to: 'a@other.com' } }, async () => passthrough)).kind, 'deny');
console.log('只开白名单时直接放行 OK');

// 取消信号要在建连前就生效
reapply();
const aborted = { signal: AbortSignal.abort(), agent: { session: { header: { cwd: '/home/lynra/邮箱插件' } } } };
await assert.rejects(() => registered.get('mail_status').execute({}, aborted), /取消/);
await assert.rejects(() => registered.get('mail_list').execute({}, aborted), /取消/);
console.log('已取消的调用不会去建连 OK');

// 连不上时 mail_status 要把问题报出来，而不是抛错
reapply({ imapHost: 'imap.invalid', smtpHost: 'smtp.invalid', timeoutMs: 5000 });
const status = await registered.get('mail_status').execute({}, { signal: new AbortController().signal });
assert.equal(status.imapOk, false, 'IMAP 连不上却报告成功');
assert.ok(status.imapError.length > 0, 'IMAP 失败没带原因');
assert.equal(status.smtpOk, false, 'SMTP 连不上却报告成功');
assert.ok(status.smtpError.length > 0, 'SMTP 失败没带原因');
assert.deepEqual(status.folders, []);
const statusText = registered.get('mail_status').output.render({}, status)[0].text;
assert.match(statusText, /IMAP 问题/);
assert.match(statusText, /SMTP 问题/);
console.log(`mail_status 排障输出 OK：${statusText.split('\n')[1].slice(0, 64)}…`);

// 只发信时不该被迫填 imapHost
reapply({ readEnabled: false, imapHost: '', smtpHost: 'smtp.invalid' });
let onlySendError;
try {
	await registered.get('mail_send').execute({ to: 'bob@example.com', subject: 'x', body: 'hi' }, { signal: new AbortController().signal });
} catch (err) {
	onlySendError = err;
}
assert.ok(onlySendError, '只发信模式本该在连 smtp.invalid 时失败，却成功了');
assert.match(onlySendError.message, /smtpHost/, `SMTP 失败要指出 smtpHost：${onlySendError.message}`);
assert.ok(!/imapHost/.test(onlySendError.message), `只发信却抱怨了 imapHost：${onlySendError.message}`);
console.log(`只发信模式不再要求 imapHost OK：${onlySendError.message.slice(0, 40)}…`);

// ---------- 输出契约：每个工具的成功返回值必须过自己 output schema 的校验 ----------
const { validateJsonSchemaValue, assertSupportedJsonSchema } = await import('@deepseek-ai/dsh-tools');
reapply();

const item = { uid: 7, date: '2026-10-25T10:00:00.000Z', subject: 's', from: ['a@b.c'], to: ['d@e.f'], cc: [], seen: false, flagged: false, answered: false, sizeBytes: 100, messageId: '<x@y>' };
const successSamples = {
	mail_status: [{ account: 'a@b.c', folder: 'INBOX', folders: ['INBOX'], messages: 8, unseen: 0, imapOk: true, imapError: '', smtpOk: true, smtpError: '' }, { account: 'a@b.c', folder: 'INBOX', folders: [], messages: 0, imapOk: false, imapError: 'x', smtpOk: false, smtpError: 'y' }],
	mail_list: [{ mailbox: 'INBOX', total: 8, unseen: 0, count: 1, items: [item] }, { mailbox: 'INBOX', total: 0, count: 0, items: [] }],
	mail_search: [
		{ mailbox: 'INBOX', matched: 12, count: 2, items: [item, item] },
		{ mailbox: 'INBOX', matched: 1, count: 1, items: [item] },
		{ mailbox: 'INBOX', matched: 0, count: 0, items: [] },
	],
	mail_read: [{ ...item, body: 'b', bodyChars: 1, bodyTruncated: false, htmlAvailable: true, attachments: [] }],
	mail_download_attachment: [{ path: '/ws/a.pdf', filename: 'a.pdf', sizeBytes: 10, contentType: 'application/pdf' }],
	mail_send: [{ messageId: '<m@x>', accepted: ['a@b.c'], rejected: [], response: '250 OK' }],
};
for (const [toolName, samples] of Object.entries(successSamples)) {
	const def = registered.get(toolName);
	assert.ok(def, `没有 ${toolName}`);
	const compiled = def.output.schema;
	assertSupportedJsonSchema(compiled);
	samples.forEach((value, index) => {
		const errors = validateJsonSchemaValue(compiled, value, 'value');
		assert.deepEqual(errors, [], `${toolName}[${index}] 的返回值不符合自己的 output schema：${errors.join('; ')}`);
	});
	// 每个工具都要能渲染，且渲染不能抛
	for (const value of samples) {
		const rendered = def.output.render({}, value);
		assert.ok(Array.isArray(rendered) && rendered.length > 0 && typeof rendered[0].text === 'string', `${toolName} 渲染失败`);
	}
}
// 反过来确认：把未知的未读数写成 null 会被判非法（这正是线上那次报错的成因）
const statusSchema = registered.get('mail_status').output.schema;
assert.ok(validateJsonSchemaValue(statusSchema, { ...successSamples.mail_status[0], unseen: null }, 'value').length > 0, 'null 未读数竟然通过了校验');
console.log(`输出契约 OK：${Object.keys(successSamples).length} 个工具的成功返回值与渲染都合规，null 未读数被正确拒绝`);

// 迟到一点再看有没有未处理的拒绝浮出来
await new Promise((resolve) => setTimeout(resolve, 500));
assert.deepEqual(leaks, [], `有未处理的 promise 拒绝泄漏：${leaks.join(' | ')}`);
console.log('无未处理拒绝泄漏 OK');

console.log('\n全部通过');
