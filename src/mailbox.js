/**
 * 邮箱协议封装：IMAP 收信（imapflow + mailparser）、SMTP 发信（nodemailer）。
 * 所有函数只接受一个已经解析好密码的 conn 对象，不关心凭据从哪来。
 *
 * @module src/mailbox
 */
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * 把协议库抛出的错误翻译成可操作的中文提示。
 * @param err - 原始错误。
 * @param protocol - 'IMAP' 或 'SMTP'。
 * @returns 替换后的 Error。
 */
export function formatError(err, protocol) {
	const text = `${err?.response ?? ''} ${err?.message ?? ''} ${err?.responseCode ?? ''} ${err?.serverCode ?? ''}`;
	if (/aborted|取消/i.test(text) && !/auth/i.test(text)) return new Error(`${protocol}：调用已取消。`);
	if (/AUTHORIZATIONFAILED|LOGINFAILED|AUTHENTICATE|invalid credentials|authentication|login|auth/i.test(text)) {
		return new Error(`${protocol} 登录失败：账号或密码/授权码不被接受。请检查 config.account（有的服务器要求登录名而不是完整邮箱地址）以及凭据里存的密码。`);
	}
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) {
		return new Error(`${protocol} 连接失败：主机名解析不了，检查 config 里的 ${protocol === 'SMTP' ? 'smtpHost' : 'imapHost'} 是否写对。`);
	}
	if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up|greeting|timeout/i.test(text)) {
		return new Error(`${protocol} 连接失败：连不上服务器或握手超时。核对 host 与 port，并确认 secure 与端口匹配——465/993 用 secure:true（隐式 TLS），587/143 要 secure:false（走 STARTTLS）。`);
	}
	if (/certificate|self-signed|unable to verify|SSL/i.test(text)) {
		return new Error(`${protocol} TLS 校验失败：服务器证书不受信任（内网自签名证书常见）。确认是自己管理的服务器后，把 config.tlsRejectUnauthorized 设为 false。`);
	}
	if (/Mailbox doesn't exist|INVALIDEMAILID|NO \[/i.test(text)) {
		return new Error(`${protocol}：${err?.message ?? '服务器拒绝了该请求'}。可用 mail_status 查看服务器上的文件夹名。`);
	}
	return new Error(`${protocol} 失败：${err?.message ?? String(err)}`);
}

/**
 * 建立一次 IMAP 连接，跑完回调后无论成败都注销。
 * @param conn - 连接参数。
 * @param signal - 调用方的 AbortSignal，可为 undefined。
 * @param fn - 拿到已连接的 client 后执行的回调。
 * @returns 回调的返回值。
 */
async function withImap(conn, signal, fn) {
	if (signal?.aborted) throw new Error('IMAP：调用已取消。');
	const client = new ImapFlow({
		host: conn.imapHost,
		port: conn.imapPort,
		secure: conn.imapSecure,
		auth: { user: conn.account, pass: conn.password },
		tls: { rejectUnauthorized: conn.tlsRejectUnauthorized },
		logger: false,
		greetingTimeout: conn.timeoutMs,
		socketTimeout: conn.timeoutMs,
	});
	const onAbort = () => client.close();
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		await client.connect();
		return await fn(client);
	} catch (err) {
		if (signal?.aborted) throw new Error('IMAP：调用已取消。');
		throw formatError(err, 'IMAP');
	} finally {
		signal?.removeEventListener('abort', onAbort);
		try {
			await client.logout();
		} catch {
			client.close();
		}
	}
}

/**
 * 构造一个 SMTP transport。
 * @param conn - 连接参数。
 * @returns nodemailer transport。
 */
function smtpTransport(conn) {
	return nodemailer.createTransport({
		host: conn.smtpHost,
		port: conn.smtpPort,
		secure: conn.smtpSecure,
		auth: { user: conn.account, pass: conn.password },
		tls: { rejectUnauthorized: conn.tlsRejectUnauthorized },
		connectionTimeout: conn.timeoutMs,
		greetingTimeout: conn.timeoutMs,
		socketTimeout: conn.timeoutMs,
		pool: false,
		logger: false,
	});
}

/**
 * 跑一个异步工作，同时允许 signal 提前中止；中止时执行 cleanup。
 * 工作以 thunk 传入，避免在检查取消之前就把 promise 发出去，
 * 那会让中止后的迟到拒绝没人接收而打崩进程。
 * @param startTask - 开始工作的函数。
 * @param signal - AbortSignal。
 * @param cleanup - 中止时的收尾动作。
 * @param protocol - 出错时标注的协议名。
 * @returns 工作结果。
 */
async function withAbort(startTask, signal, cleanup, protocol) {
	if (!signal) return startTask();
	if (signal.aborted) throw new Error(`${protocol}：调用已取消。`);
	const task = startTask();
	// 中止后 task 自己仍会失败，先接住那条拒绝；race 用的分支在下面单独处理
	task.catch(() => {});
	let onAbort;
	try {
		return await new Promise((resolve, reject) => {
			onAbort = () => {
				cleanup();
				reject(new Error(`${protocol}：调用已取消。`));
			};
			signal.addEventListener('abort', onAbort, { once: true });
			task.then(resolve, reject);
		});
	} finally {
		if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
	}
}

/**
 * 把地址对象数组转成 "名字 <邮箱>" 字符串列表。
 * @param list - imapflow 的地址数组。
 * @returns 可读地址列表。
 */
function formatAddresses(list) {
	if (!Array.isArray(list)) return [];
	return list
		.filter((item) => typeof item?.address === 'string' && item.address.length > 0)
		.map((item) => (item.name ? `${item.name} <${item.address}>` : item.address));
}

/**
 * 取 imapflow flags 里的单个标记。
 * @param flags - Set 或数组。
 * @param name - 标记名，如 '\\Seen'。
 * @returns 是否带该标记。
 */
function hasFlag(flags, name) {
	if (!flags) return false;
	if (typeof flags.has === 'function') return flags.has(name);
	return Array.isArray(flags) && flags.includes(name);
}

/**
 * 把邮件日期归一成 ISO 字符串。
 * @param date - Date、字符串或缺失。
 * @returns ISO 字符串，缺省空串。
 */
function isoDate(date) {
	if (date instanceof Date && !Number.isNaN(date.getTime())) return date.toISOString();
	if (typeof date === 'string' && date.length > 0) {
		const parsed = new Date(date);
		return Number.isNaN(parsed.getTime()) ? date : parsed.toISOString();
	}
	return '';
}

/**
 * 由 fetch 结果拼出列表条目。
 * @param msg - imapflow 消息对象。
 * @returns 摘要对象。
 */
function toSummary(msg) {
	const env = msg.envelope ?? {};
	return {
		uid: msg.uid,
		date: isoDate(env.date),
		subject: env.subject ?? '(无主题)',
		from: formatAddresses(env.from),
		to: formatAddresses(env.to),
		cc: formatAddresses(env.cc),
		seen: hasFlag(msg.flags, '\\Seen'),
		flagged: hasFlag(msg.flags, '\\Flagged'),
		answered: hasFlag(msg.flags, '\\Answered'),
		sizeBytes: msg.size,
		messageId: env.messageId ?? '',
	};
}

/**
 * 粗略地把 HTML 正文转成纯文本（无 text/plain 部件时兜底）。
 * @param html - HTML 字符串。
 * @returns 纯文本。
 */
function stripHtml(html) {
	return String(html)
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|tr|li)>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * 校验并解析一个必须落在工作区内的路径。
 * @param root - 工作区绝对路径。
 * @param target - 模型给出的路径（相对或绝对）。
 * @returns 解析后的绝对路径。
 */
export function resolveInsideWorkspace(root, target) {
	if (typeof target !== 'string' || target.trim().length === 0) throw new Error('路径不能为空。');
	const abs = path.resolve(root, target);
	const rel = path.relative(root, abs);
	if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
		throw new Error(`只能在工作区 ${root} 内读写文件，收到的是 ${abs}。`);
	}
	return abs;
}

/**
 * 列出服务器上的文件夹。
 * 注意：运行时只有 `list()`，类型声明里的 `getMailboxList` 并不存在；
 * `listTree()` 返回的不是数组，`status()` 在部分服务器（如 spacemail）恒返回 false。
 * @param client - 已连接的 IMAP client。
 * @returns 文件夹路径数组，取不到时为空数组。
 */
async function listFolders(client) {
	try {
		const list = await client.list();
		return Array.isArray(list) ? list.map((item) => item.path) : [];
	} catch {
		return [];
	}
}

/**
 * 数未读封数。SELECT 响应里的 UNSEEN 在全部已读时会被服务器省略，
 * 所以要回落成一次服务端 SEARCH。
 * @param client - 已连接的 IMAP client。
 * @param mailbox - 文件夹。
 * @param selected - 当前是否已经 SELECT 过该文件夹。
 * @returns 未读封数，拿不到时返回 null。
 */
async function countUnseen(client, mailbox, selected) {
	if (selected && typeof client.mailbox?.unseen === 'number') return client.mailbox.unseen;
	try {
		const uids = await client.search({ seen: false }, { uid: true });
		return Array.isArray(uids) ? uids.length : null;
	} catch {
		return null;
	}
}

/**
 * 检查文件夹是否存在，不存在时报出可用名字。
 * @param client - 已连接的 IMAP client。
 * @param mailbox - 文件夹路径。
 * @returns 无。
 */
async function assertMailbox(client, mailbox) {
	const names = await listFolders(client);
	if (names.length === 0 || names.includes(mailbox)) return;
	if (names.some((name) => name.toLowerCase() === mailbox.toLowerCase())) return;
	throw new Error(`IMAP：服务器上没有名为 ${mailbox} 的文件夹。可用文件夹：${names.slice(0, 30).join(', ')}`);
}

/**
 * 按搜索条件取回一批消息（摘要，不下载正文）。
 * @param client - 已连接的 IMAP client。
 * @param mailbox - 文件夹。
 * @param query - imapflow 搜索对象。
 * @param limit - 最多返回条数，取最新的若干封。
 * @returns 摘要列表，按日期从新到旧。
 */
async function fetchSummaries(client, mailbox, query, limit) {
	// SEARCH 必须在选中文件夹之后发，所以锁要罩住搜索本身
	const lock = await client.getMailboxLock(mailbox);
	let picked = [];
	let matched = 0;
	try {
		const uids = await client.search(query, { uid: true });
		if (uids === false || uids === undefined) throw new Error('IMAP：服务器不接受该搜索条件，换一个更简单的组合（例如只按 subject 或 from）。');
		const list = Array.isArray(uids) ? uids : [];
		matched = list.length;
		picked = [];
		for (const uid of list.slice(-limit)) {
			const msg = await client.fetchOne(uid, { uid: true, envelope: true, flags: true, size: true }, { uid: true });
			if (msg && msg !== false) picked.push(toSummary(msg));
		}
	} finally {
		lock.release();
	}
	return { items: picked.reverse(), matched };
}

/**
 * 列出邮箱里的邮件（默认最近若干封，可只看未读）。
 * @param conn - 连接参数。
 * @param opts - { mailbox, limit, unreadOnly }。
 * @param signal - AbortSignal。
 * @returns { mailbox, total, unseen, items }。
 */
export async function listMessages(conn, opts, signal) {
	return withImap(conn, signal, async (client) => {
		await assertMailbox(client, opts.mailbox);
		const lock = await client.getMailboxLock(opts.mailbox);
		let total = 0;
		let unseen = null;
		try {
			total = client.mailbox?.exists ?? 0;
			unseen = await countUnseen(client, opts.mailbox, true);
		} finally {
			lock.release();
		}
		const query = opts.unreadOnly ? { seen: false } : { all: true };
		const found = await fetchSummaries(client, opts.mailbox, query, opts.limit);
		return { mailbox: opts.mailbox, total, ...(typeof unseen === 'number' ? { unseen } : {}), count: found.items.length, items: found.items };
	});
}

/**
 * 按条件搜索邮件。
 * @param conn - 连接参数。
 * @param opts - { mailbox, limit, subject, from, to, body, text, since, before, unreadOnly }。
 * @param signal - AbortSignal。
 * @returns { mailbox, count, items }。
 */
export async function searchMessages(conn, opts, signal) {
	const query = {};
	if (opts.subject) query.subject = opts.subject;
	if (opts.from) query.from = opts.from;
	if (opts.to) query.to = opts.to;
	if (opts.body) query.body = opts.body;
	if (opts.text) query.text = opts.text;
	if (opts.since) query.since = opts.since;
	if (opts.before) query.before = opts.before;
	if (opts.unreadOnly) query.seen = false;
	if (Object.keys(query).length === 0) throw new Error('至少给出一个搜索条件：subject / from / to / body / text / since / before / unreadOnly。');
	return withImap(conn, signal, async (client) => {
		await assertMailbox(client, opts.mailbox);
		const found = await fetchSummaries(client, opts.mailbox, query, opts.limit);
		return { mailbox: opts.mailbox, matched: found.matched, count: found.items.length, items: found.items };
	});
}

/**
 * 下载一封邮件的原文并解析成正文与附件列表。
 * @param conn - 连接参数。
 * @param opts - { mailbox, uid, maxChars }。
 * @param signal - AbortSignal。
 * @returns 正文与附件元数据。
 */
export async function readMessage(conn, opts, signal) {
	return withImap(conn, signal, async (client) => {
		await assertMailbox(client, opts.mailbox);
		const lock = await client.getMailboxLock(opts.mailbox);
		let msg;
		let raw;
		try {
			msg = await client.fetchOne(
				opts.uid,
				{ uid: true, envelope: true, flags: true, size: true, source: { maxLength: conn.maxMessageBytes } },
				{ uid: true },
			);
			if (!msg || msg === false) throw new Error(`IMAP：${opts.mailbox} 里没有 UID ${opts.uid} 的邮件。先用 mail_list 或 mail_search 取一个真实 uid。`);
			raw = msg.source;
		} finally {
			lock.release();
		}
		if (!raw || raw.length === 0) throw new Error(`IMAP：UID ${opts.uid} 的正文为空或超过 maxMessageBytes 上限（${conn.maxMessageBytes} 字节），未下载。`);
		const parsed = await simpleParser(raw);
		const body = (parsed.text ?? '').trim() || stripHtml(parsed.html ?? '');
		const truncated = body.length > opts.maxChars;
		return {
			...toSummary(msg),
			bodyTruncated: truncated,
			bodyChars: body.length,
			body: truncated ? body.slice(0, opts.maxChars) : body,
			htmlAvailable: Boolean(parsed.html),
			attachments: (parsed.attachments ?? []).map((item, index) => ({
				index,
				filename: item.filename || `attachment-${index}`,
				contentType: item.contentType || 'application/octet-stream',
				sizeBytes: item.size ?? item.content?.length ?? 0,
				inline: Boolean(item.contentId),
			})),
		};
	});
}

/**
 * 把一封信的某个附件写到工作区里的文件。
 * @param conn - 连接参数。
 * @param opts - { mailbox, uid, index, workspaceDir, filename }。
 * @param signal - AbortSignal。
 * @returns { path, filename, sizeBytes }。
 */
export async function saveAttachment(conn, opts, signal) {
	const safeName = path.basename(opts.filename || `attachment-${opts.index}`).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
	if (safeName.length === 0) throw new Error('附件名不合法。');
	const target = resolveInsideWorkspace(opts.workspaceDir, path.join(path.relative(opts.workspaceDir, opts.dir) || '.', safeName));
	return withImap(conn, signal, async (client) => {
		await assertMailbox(client, opts.mailbox);
		const lock = await client.getMailboxLock(opts.mailbox);
		let msg;
		try {
			msg = await client.fetchOne(opts.uid, { uid: true, source: { maxLength: conn.maxMessageBytes } }, { uid: true });
			if (!msg || msg === false) throw new Error(`IMAP：${opts.mailbox} 里没有 UID ${opts.uid} 的邮件。`);
		} finally {
			lock.release();
		}
		const parsed = await simpleParser(msg.source);
		const attachments = parsed.attachments ?? [];
		const picked = attachments[opts.index];
		if (!picked) throw new Error(`这封信只有 ${attachments.length} 个附件（index 从 0 开始），要的是 ${opts.index}。`);
		const content = picked.content ?? Buffer.alloc(0);
		if (content.length > conn.maxMessageBytes) throw new Error(`附件 ${safeName} 有 ${content.length} 字节，超过 maxMessageBytes 上限 ${conn.maxMessageBytes}。`);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, content);
		return { path: target, filename: safeName, sizeBytes: content.length, contentType: picked.contentType || 'application/octet-stream' };
	});
}

/**
 * 探测收发两边是否可用。两侧失败都作为结果返回而不抛出，
 * 这样 mail_status 能一次报全，便于排障。
 * @param conn - 连接参数。
 * @param signal - AbortSignal。
 * @returns 两侧状态与文件夹列表。
 */
export async function probeConnection(conn, signal) {
	const result = { account: conn.account, imap: {}, smtp: {} };
	try {
		result.imap = await withImap(conn, signal, async (client) => {
			const lock = await client.getMailboxLock(conn.folder);
			let exists = 0;
			let unseen = null;
			let folders = [];
			try {
				exists = client.mailbox?.exists ?? 0;
				unseen = await countUnseen(client, conn.folder, true);
				folders = await listFolders(client);
			} finally {
				lock.release();
			}
			return { ok: true, folder: conn.folder, messages: exists, unseen, folders: folders.slice(0, 40) };
		});
	} catch (err) {
		result.imap = { ok: false, error: err.message, folders: [], messages: 0, unseen: null };
	}
	const transport = smtpTransport(conn);
	try {
		await withAbort((async () => transport.verify()), signal, () => transport.close(), 'SMTP');
		result.smtp = { ok: true };
	} catch (err) {
		result.smtp = { ok: false, error: formatError(err, 'SMTP').message };
	} finally {
		transport.close();
	}
	// 取消不是探测结论，要作为失败抛回调用方
	if (signal?.aborted) throw new Error('IMAP/SMTP 探测已被取消。');
	return result;
}

/**
 * 通过 SMTP 发出一封信。
 * @param conn - 连接参数。
 * @param mail - nodemailer 的邮件对象（附件路径已校验）。
 * @param signal - AbortSignal。
 * @returns { messageId, accepted, rejected, response }。
 */
export async function sendMessage(conn, mail, signal) {
	const transport = smtpTransport(conn);
	try {
		const info = await withAbort((async () => transport.sendMail(mail)), signal, () => transport.close(), 'SMTP');
		return {
			messageId: info.messageId ?? '',
			accepted: info.accepted ?? [],
			rejected: info.rejected ?? [],
			response: String(info.response ?? '').trim(),
		};
	} catch (err) {
		throw formatError(err, 'SMTP');
	} finally {
		transport.close();
	}
}
