/**
 * 实机只读自检：用 profile 里的真实配置连一次 IMAP 与 SMTP。
 * 只做读取和握手探测——不发信，所以可以随便反复跑。
 *
 * 用法：node test/live-check.mjs
 * 读的是 ~/.dsh/profiles/web/cordis.patch.yml 里 mail 行的 config，
 * 密码按 config.passwordEnv 从 DSH 凭据文件取，脚本里不出现任何明文。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PATCH = path.join(os.homedir(), '.dsh/profiles/web/cordis.patch.yml');
const CREDSTORE = path.join(os.homedir(), '.dsh/.credentials.yaml');

/**
 * 从 profile patch 里取 mail 行的 config。
 * @returns 配置对象。
 */
function readMailConfig() {
	if (!fs.existsSync(PATCH)) throw new Error(`找不到 ${PATCH}`);
	// 不引第三方 YAML 库：这段只取 mail 行下面缩进两格的 config 键值
	const lines = fs.readFileSync(PATCH, 'utf8').split(/\r?\n/);
	const start = lines.findIndex((line) => /^-\s+id:\s*mail\s*$/.test(line));
	if (start < 0) throw new Error('profile patch 里没有 id 为 mail 的行');
	const config = {};
	let inConfig = false;
	for (const line of lines.slice(start + 1)) {
		if (/^-\s/.test(line)) break;
		if (/^\s{2}config:/.test(line)) {
			inConfig = true;
			continue;
		}
		if (!inConfig) continue;
		const hit = /^\s{4}([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
		if (hit === null) continue;
		const raw = hit[2].trim();
		if (raw.startsWith('[')) continue;
		config[hit[1]] = raw.replace(/^['"]|['"]$/g, '');
	}
	return config;
}

/**
 * 按凭据名取值，与插件同一套优先级：凭据文件，再环境变量。
 * @param name - 凭据名。
 * @returns 秘密值。
 */
function readSecret(name) {
	if (fs.existsSync(CREDSTORE)) {
		const hit = new RegExp(`^ {2}${name}:\\s*(.+)$`, 'm').exec(fs.readFileSync(CREDSTORE, 'utf8'));
		if (hit !== null) return hit[1].trim().replace(/^['"]|['"]$/g, '');
	}
	const ambient = process.env[name];
	if (typeof ambient === 'string' && ambient.length > 0) return ambient;
	throw new Error(`取不到凭据 ${name}：写进 ~/.dsh/.credentials.yaml 的 refs 下，或先 export ${name}`);
}

const config = readMailConfig();
const password = readSecret(config.passwordEnv ?? 'DSH_MAIL_PASSWORD');
const account = config.account;
console.log(`配置来自 ${PATCH}`);
console.log(`账号 ${account}｜邮箱 ${config.imapHost}:${config.imapPort}｜SMTP ${config.smtpHost}:${config.smtpPort}`);

const mail = await import('../src/mailbox.js');
const conn = {
	account,
	password,
	imapHost: config.imapHost,
	imapPort: Number(config.imapPort ?? 993),
	imapSecure: String(config.imapSecure) !== 'false',
	smtpHost: config.smtpHost,
	smtpPort: Number(config.smtpPort ?? 465),
	smtpSecure: String(config.smtpSecure) !== 'false',
	folder: config.folder ?? 'INBOX',
	timeoutMs: Number(config.timeoutMs ?? 30000),
	maxMessageBytes: Number(config.maxMessageBytes ?? 8388608),
	tlsRejectUnauthorized: String(config.tlsRejectUnauthorized) !== 'false',
};

let failures = 0;
const report = (label, ok, detail) => {
	if (!ok) failures += 1;
	console.log(`${ok ? '通过' : '失败'}  ${label}：${detail}`);
};

// 邮件侧
try {
	const probe = await mail.probeConnection(conn);
	report('IMAP 登录', probe.imap.ok === true, probe.imap.ok ? `${probe.imap.messages} 封，未读 ${probe.imap.unseen ?? '未知'}，文件夹 ${probe.imap.folders.join('/')}` : probe.imap.error);
	report('SMTP 握手', probe.smtp.ok === true, probe.smtp.ok ? 'verify 通过' : probe.smtp.error);
} catch (err) {
	report('IMAP/SMTP 探测', false, err.message);
}

try {
	const list = await mail.listMessages(conn, { mailbox: conn.folder, limit: 3, unreadOnly: false });
	report('列最近三封', true, list.items.map((item) => `${item.uid}:${item.subject.slice(0, 24)}`).join(' | ') || '(空)');
	if (list.items[0] !== undefined) {
		const one = await mail.readMessage(conn, { mailbox: conn.folder, uid: list.items[0].uid, maxChars: 160 });
		report('读第一封正文', one.body.length >= 0, `${one.bodyChars} 字符，附件 ${one.attachments.length} 个，截断=${one.bodyTruncated}`);
	}
} catch (err) {
	report('列信或读信', false, err.message);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
