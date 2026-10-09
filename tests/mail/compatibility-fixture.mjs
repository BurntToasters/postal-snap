// Failure inventory (before fixture implementation):
// - Authentication before required STARTTLS must fail.
// - Wrong credentials and rejected ENABLE extensions must stay explicit.
// - Missing capabilities must not be advertised by default.
// - Invalid certificates must fail ordinary client verification.
// - Stop/restart must close active sockets and release listening ports.
// - Protocol transcripts must never enter result artifacts.

import { readFile } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import assert from "node:assert/strict";

// Synthetic credentials only; callers may supply fixture-specific values.
export async function createCompatibilityFixture({
  certificatePath,
  keyPath,
  tlsMode = "startTls",
  capabilities = ["IMAP4rev1"],
  rejectEnable = true,
  advertiseStartTls = true,
  rejectStartTls = false,
  allowRestartCommand = false,
  username = "fixture@example.test",
  password = "fixture-password",
  imapPort = 0,
  smtpPort = 0,
  folderNames = [
    "INBOX",
    "Archive",
    "Labels",
    "Labels/Project",
    "Labels/Sent",
    "All Mail",
  ],
  messages = {},
  uidValidity = 1,
  uidValidityOnRestart,
  interruptMoveAfterCopy = false,
  interruptAppendAfterCommit = false,
}) {
  if (!["tls", "startTls"].includes(tlsMode))
    throw new Error("Invalid fixture TLS mode.");
  const options = {
    cert: await readFile(certificatePath),
    key: await readFile(keyPath),
  };
  const context = tls.createSecureContext(options);
  const sockets = new Set();
  const servers = [];
  const counts = {
    connections: 0,
    authenticated: 0,
    rejectedAuthentication: 0,
    messagesAccepted: 0,
    restarts: 0,
    restartFailed: false,
    interruptedMoves: 0,
    interruptedAppends: 0,
    copiedMessages: 0,
    appendedMessages: 0,
    fetchCommands: 0,
    fetchItems: 0,
    utf8AcceptRequested: 0,
    utf8AcceptEnabled: 0,
  };
  const mailboxes = new Map(
    folderNames.map((name) => [
      name,
      (messages[name] ?? []).map((message) => ({
        ...message,
        flags: [...(message.flags ?? [])],
      })),
    ]),
  );
  let currentUidValidity = uidValidity;
  let interruptMovePending = interruptMoveAfterCopy;
  let interruptAppendPending = interruptAppendAfterCommit;
  let ports = { imap: imapPort, smtp: smtpPort };

  function encodeMailbox(name) {
    return name.replace(/[^\x20-\x7e]+|&/g, (part) => {
      if (part === "&") return "&-";
      const bytes = Buffer.alloc(part.length * 2);
      for (let index = 0; index < part.length; index += 1)
        bytes.writeUInt16BE(part.charCodeAt(index), index * 2);
      return `&${bytes.toString("base64").replace(/=+$/u, "").replaceAll("/", ",")}-`;
    });
  }

  function decodeMailbox(value) {
    return value.replace(/&([A-Za-z0-9+,]*)-/g, (_match, encoded) => {
      if (!encoded) return "&";
      const base64 = encoded.replaceAll(",", "/");
      const bytes = Buffer.from(
        base64 + "=".repeat((4 - (base64.length % 4)) % 4),
        "base64",
      );
      let text = "";
      for (let index = 0; index + 1 < bytes.length; index += 2)
        text += String.fromCharCode(bytes.readUInt16BE(index));
      return text;
    });
  }

  function messageRaw(message) {
    if (message.raw) return Buffer.from(message.raw);
    const subject =
      currentUidValidity > uidValidity && message.subjectAfterRestart
        ? message.subjectAfterRestart
        : (message.subject ?? "Fixture message");
    return Buffer.from(
      `From: ${message.from ?? "Fixture Sender <sender@example.test>"}\r\nTo: Fixture <fixture@example.test>\r\nSubject: ${subject}\r\nMessage-ID: ${message.messageId ?? `<fixture-${message.uid}@example.test>`}\r\nDate: Thu, 01 Jan 2026 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message.body ?? "Synthetic fixture body"}`,
    );
  }

  function messageId(message) {
    return (
      /^Message-ID:\s*(.+)$/im
        .exec(messageRaw(message).toString("utf8"))?.[1]
        ?.trim() ?? ""
    );
  }

  function selectedMessages(name) {
    return mailboxes.get(name) ?? [];
  }

  function nextUid(name) {
    return (
      Math.max(
        0,
        ...(mailboxes.get(name) ?? []).map((message) => message.uid),
      ) + 1
    );
  }

  function appendMessage(name, raw, flags = []) {
    const mailbox = mailboxes.get(name);
    if (!mailbox) return undefined;
    const bytes = Buffer.from(raw);
    const text = bytes.toString("utf8");
    const message = {
      uid: nextUid(name),
      raw: bytes,
      messageId: /^Message-ID:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? "",
      subject:
        /^Subject:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? "Fixture message",
      flags,
    };
    mailbox.push(message);
    counts.appendedMessages++;
    return message;
  }

  function session(initialSocket, protocol) {
    let socket = initialSocket;
    let secure = tlsMode === "tls";
    let authenticated = false;
    let buffer = Buffer.alloc(0);
    let selectedMailbox = "";
    let literal = null;
    let utf8AcceptEnabled = false;
    let authState = null;
    let smtpUser = "";
    let smtpData = false;
    counts.connections++;
    function track(current) {
      sockets.add(current);
      current.on("error", () => current.destroy());
      current.on("close", () => sockets.delete(current));
    }
    track(socket);
    const send = (line) => socket.write(`${line}\r\n`);
    const wireMailbox = (name) => {
      const value = encodeMailbox(name);
      return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    };
    const sendMailboxResponse = (prefix, name, suffix = "") => {
      if (!utf8AcceptEnabled) {
        send(`${prefix}${wireMailbox(name)}${suffix}`);
        return;
      }
      send(`${prefix}"${name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"${suffix}`);
    };
    function authenticate(user, secret, prefix = "") {
      authenticated = user === username && secret === password;
      counts[authenticated ? "authenticated" : "rejectedAuthentication"]++;
      send(
        protocol === "imap"
          ? `${prefix} ${authenticated ? "OK authenticated" : "NO authentication rejected"}`
          : authenticated
            ? "235 2.7.0 authenticated"
            : "535 5.7.8 authentication rejected",
      );
    }
    function upgrade() {
      socket.removeListener("data", onData);
      socket.pause();
      buffer = Buffer.alloc(0);
      socket = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext: context,
      });
      track(socket);
      secure = true;
      socket.on("data", onData);
      socket.resume();
    }
    function imap(line) {
      const match = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
      if (!match) return socket.destroy();
      const [, tag, rawCommand, args = ""] = match;
      const command = rawCommand.toUpperCase();
      if (command === "CAPABILITY") {
        const advertised = [
          ...capabilities,
          ...(!secure
            ? [...(advertiseStartTls ? ["STARTTLS"] : []), "LOGINDISABLED"]
            : []),
        ];
        send(`* CAPABILITY ${advertised.join(" ")}`);
        send(`${tag} OK capability`);
      } else if (command === "STARTTLS") {
        if (secure) return send(`${tag} BAD already secure`);
        if (rejectStartTls) return send(`${tag} NO STARTTLS unavailable`);
        send(`${tag} OK begin TLS`);
        upgrade();
      } else if (command === "LOGIN") {
        if (!secure) return send(`${tag} NO required STARTTLS`);
        const values = args.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
        const unquote = (value = "") =>
          value.startsWith('"')
            ? value.slice(1, -1).replace(/\\(.)/g, "$1")
            : value;
        authenticate(unquote(values[0]), unquote(values[1]), tag);
      } else if (command === "LOGOUT") {
        send("* BYE closing");
        send(`${tag} OK logout`);
        socket.end();
      } else if (!authenticated) {
        send(`${tag} NO authenticate first`);
      } else if (command === "XFIXTURERESTART" && allowRestartCommand) {
        socket.write(`${tag} OK restarting\r\n`, () => {
          setImmediate(async () => {
            try {
              await stop();
              if (uidValidityOnRestart !== undefined)
                currentUidValidity = uidValidityOnRestart;
              await start();
              counts.restarts++;
            } catch {
              counts.restartFailed = true;
            }
          });
        });
      } else if (command === "ENABLE") {
        if (args.toUpperCase().includes("UTF8=ACCEPT"))
          counts.utf8AcceptRequested++;
        if (rejectEnable) send(`${tag} BAD extension unavailable`);
        else {
          if (args.toUpperCase().includes("UTF8=ACCEPT")) {
            utf8AcceptEnabled = true;
            counts.utf8AcceptEnabled++;
          }
          send(`* ENABLED ${args}`);
          send(`${tag} OK enabled`);
        }
      } else if (command === "NOOP") {
        send(`${tag} OK noop`);
      } else if (command === "LIST" || command === "LSUB") {
        for (const name of mailboxes.keys()) {
          const flags = name === "All Mail" ? "(\\All)" : "()";
          sendMailboxResponse(`* ${command} ${flags} "/" `, name);
        }
        send(`${tag} OK listed`);
      } else if (command === "STATUS") {
        const rawName = args.match(/^"(?:[^"\\]|\\.)*"|^\S+/)?.[0] ?? "";
        const mailbox = decodeMailbox(
          rawName
            .replace(/^"|"$/g, "")
            .replaceAll('\\"', '"')
            .replaceAll("\\\\", "\\"),
        );
        const rows = selectedMessages(mailbox);
        const unseen = rows.filter(
          (message) => !message.flags?.includes("\\Seen"),
        ).length;
        sendMailboxResponse(
          "* STATUS ",
          mailbox,
          ` (MESSAGES ${rows.length} UNSEEN ${unseen} UIDNEXT ${nextUid(mailbox)} UIDVALIDITY ${currentUidValidity} HIGHESTMODSEQ ${currentUidValidity})`,
        );
        send(`${tag} OK status`);
      } else if (
        (command === "UID" && /^FETCH\b/i.test(args)) ||
        command === "FETCH"
      ) {
        counts.fetchCommands++;
        const fetchArgs = command === "UID" ? args : `FETCH ${args}`;
        const [, set = "", query = ""] =
          /^FETCH\s+(\S+)\s+([\s\S]+)$/i.exec(fetchArgs) ?? [];
        const uids = new Set(
          set.split(",").flatMap((part) => {
            const [start, end] = part.split(":").map(Number);
            if (!Number.isFinite(start)) return [];
            if (!Number.isFinite(end)) return [start];
            return Array.from(
              { length: Math.max(0, end - start + 1) },
              (_, offset) => start + offset,
            );
          }),
        );
        for (const [index, message] of selectedMessages(
          selectedMailbox,
        ).entries()) {
          if (!uids.has(message.uid)) continue;
          counts.fetchItems++;
          const raw = messageRaw(message);
          const flags = message.flags?.length
            ? `(${message.flags.join(" ")})`
            : "()";
          let items = `UID ${message.uid} FLAGS ${flags} RFC822.SIZE ${raw.length} INTERNALDATE "01-Jan-2026 12:00:00 +0000"`;
          if (query.toUpperCase().includes("ENVELOPE")) {
            const subject =
              currentUidValidity > uidValidity && message.subjectAfterRestart
                ? message.subjectAfterRestart
                : (message.subject ?? "Fixture message");
            const address = '(("Fixture Sender" NIL "sender" "example.test"))';
            items += ` ENVELOPE (NIL "${subject.replaceAll('"', '\\"')}" ${address} ${address} ${address} ${address} NIL NIL NIL "${messageId(message)}")`;
          }
          const headerQuery = /BODY(?:\.PEEK)?\[HEADER\.FIELDS[^\]]*\]/i.exec(
            query,
          )?.[0];
          if (headerQuery) {
            const header = Buffer.from(
              `Message-ID: ${messageId(message)}\r\nReferences: \r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`,
            );
            // PEEK is a request modifier and never appears in FETCH responses.
            const headerResponse = headerQuery.replace(/^BODY\.PEEK/i, "BODY");
            items += ` ${headerResponse} {${header.length}}\r\n${header.toString("utf8")}`;
          } else if (/BODY(?:\.PEEK)?\[\]/i.test(query)) {
            items += ` BODY[] {${raw.length}}\r\n${raw.toString("utf8")}`;
          }
          send(`* ${index + 1} FETCH (${items})`);
        }
        send(`${tag} OK fetched`);
      } else if (command === "UID" && /^SEARCH\b/i.test(args)) {
        const criterion = args.replace(/^SEARCH\s+/i, "");
        let matches = selectedMessages(selectedMailbox);
        const headerId = /HEADER\s+MESSAGE-ID\s+"((?:[^"\\]|\\.)*)"/i.exec(
          criterion,
        )?.[1];
        const subject = /SUBJECT\s+"((?:[^"\\]|\\.)*)"/i.exec(criterion)?.[1];
        if (headerId) {
          const wanted = headerId
            .replaceAll('\\"', '"')
            .replaceAll("\\\\", "\\");
          matches = matches.filter((message) => messageId(message) === wanted);
        }
        if (subject) {
          const wanted = subject
            .replaceAll('\\"', '"')
            .replaceAll("\\\\", "\\")
            .toLocaleLowerCase();
          matches = matches.filter((message) =>
            (message.subject ?? "").toLocaleLowerCase().includes(wanted),
          );
        }
        send(
          `* SEARCH ${matches.map((message) => message.uid).join(" ")}`.trimEnd(),
        );
        send(`${tag} OK searched`);
      } else if (command === "RENAME") {
        const values = args.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
        const unquote = (value = "") =>
          value.startsWith('"')
            ? value.slice(1, -1).replace(/\\(.)/g, "$1")
            : value;
        const rawNames = values.map(unquote);
        const validLegacyNames = rawNames.every(
          (name) =>
            utf8AcceptEnabled ||
            (!/[^\x20-\x7e]/u.test(name) &&
              !/&(?![A-Za-z0-9+,]*-)/u.test(name)),
        );
        if (!validLegacyNames) {
          send(`${tag} BAD mailbox name is not valid modified UTF-7`);
          return;
        }
        const [oldName, newName] = rawNames.map(decodeMailbox);
        const source = mailboxes.get(oldName);
        if (!source || mailboxes.has(newName)) {
          send(`${tag} NO mailbox rename is unavailable`);
          return;
        }
        const descendants = [...mailboxes.keys()].filter((name) =>
          name.startsWith(`${oldName}/`),
        );
        for (const name of [oldName, ...descendants]) {
          const suffix = name.slice(oldName.length);
          const nextName = `${newName}${suffix}`;
          const messages = mailboxes.get(name);
          mailboxes.delete(name);
          mailboxes.set(nextName, messages ?? []);
        }
        send(`${tag} OK renamed`);
      } else if (command === "UID" && /^COPY\b/i.test(args)) {
        const [, set = "", rawDestination = ""] =
          /^COPY\s+(\S+)\s+([\s\S]+)$/i.exec(args) ?? [];
        const destination = decodeMailbox(
          rawDestination
            .replace(/^"|"$/g, "")
            .replaceAll('\\"', '"')
            .replaceAll("\\\\", "\\"),
        );
        const selected = selectedMessages(selectedMailbox);
        const target = mailboxes.get(destination);
        const wanted = new Set(set.split(",").map(Number));
        for (const message of selected.filter((row) => wanted.has(row.uid))) {
          if (target) {
            target.push({
              ...message,
              uid: nextUid(destination),
              flags: [...(message.flags ?? [])],
            });
            counts.copiedMessages++;
          }
        }
        if (interruptMovePending) {
          interruptMovePending = false;
          counts.interruptedMoves++;
          socket.destroy();
          return;
        }
        send(`${tag} OK copied`);
      } else if (command === "UID" && /^STORE\b/i.test(args)) {
        const [, set = "", operation = ""] =
          /^STORE\s+(\S+)\s+([\s\S]+)$/i.exec(args) ?? [];
        const wanted = new Set(set.split(",").map(Number));
        for (const message of selectedMessages(selectedMailbox)) {
          if (!wanted.has(message.uid)) continue;
          if (operation.includes("\\Deleted") && operation.startsWith("+")) {
            if (!message.flags.includes("\\Deleted"))
              message.flags.push("\\Deleted");
          }
          if (operation.includes("\\Seen") && operation.startsWith("+")) {
            if (!message.flags.includes("\\Seen")) message.flags.push("\\Seen");
          }
        }
        send(`${tag} OK stored`);
      } else if (command === "UID" && /^EXPUNGE\b/i.test(args)) {
        const wanted = new Set(
          args
            .replace(/^EXPUNGE\s+/i, "")
            .split(",")
            .map(Number),
        );
        const rows = selectedMessages(selectedMailbox);
        mailboxes.set(
          selectedMailbox,
          rows.filter(
            (message) =>
              !(wanted.has(message.uid) && message.flags.includes("\\Deleted")),
          ),
        );
        send(`${tag} OK expunged`);
      } else if (command === "APPEND") {
        const parsed =
          /^((?:"(?:[^"\\]|\\.)*"|\S+))(?:\s+\(([^)]*)\))?(?:\s+"[^"]+")?\s+\{(\d+)\}$/i.exec(
            args,
          );
        if (!parsed) return send(`${tag} BAD invalid append`);
        const rawName = parsed[1]
          .replace(/^"|"$/g, "")
          .replaceAll('\\"', '"')
          .replaceAll("\\\\", "\\");
        literal = {
          bytes: Number(parsed[3]),
          flags: parsed[2] ? parsed[2].split(/\s+/) : [],
          mailbox: decodeMailbox(rawName),
          tag,
        };
        send("+ continue");
      } else if (command === "SELECT" || command === "EXAMINE") {
        const rawName = args.match(/^"(?:[^"\\]|\\.)*"|^\S+/)?.[0] ?? "";
        selectedMailbox = decodeMailbox(
          rawName
            .replace(/^"|"$/g, "")
            .replaceAll('\\"', '"')
            .replaceAll("\\\\", "\\"),
        );
        const rows = selectedMessages(selectedMailbox);
        send("* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)");
        send(`* ${rows.length} EXISTS`);
        send(`* OK [UIDVALIDITY ${currentUidValidity}] generation`);
        send(`* OK [UIDNEXT ${nextUid(selectedMailbox)}] next`);
        send(`${tag} OK [READ-WRITE] selected`);
      } else {
        send(`${tag} BAD unsupported fixture command`);
      }
    }
    function smtp(line) {
      if (smtpData) {
        if (line === ".") {
          smtpData = false;
          counts.messagesAccepted++;
          send("250 2.0.0 queued");
        }
        return;
      }
      if (authState === "user") {
        smtpUser = Buffer.from(line, "base64").toString();
        authState = "password";
        send("334 UGFzc3dvcmQ6");
        return;
      }
      if (authState === "password") {
        authState = null;
        authenticate(smtpUser, Buffer.from(line, "base64").toString());
        return;
      }
      if (authState === "plain") {
        authState = null;
        const [, user, secret] = Buffer.from(line, "base64")
          .toString()
          .split("\0");
        authenticate(user, secret);
        return;
      }
      const [rawCommand, ...parts] = line.split(" ");
      const command = rawCommand.toUpperCase();
      if (command === "EHLO" || command === "HELO") {
        send("250-fixture.example.test");
        if (!secure && advertiseStartTls) send("250-STARTTLS");
        if (secure) send("250-AUTH PLAIN LOGIN");
        send("250 SIZE 1048576");
      } else if (command === "STARTTLS") {
        if (secure) return send("503 5.5.1 already secure");
        if (rejectStartTls) return send("454 4.7.0 STARTTLS unavailable");
        send("220 2.0.0 begin TLS");
        upgrade();
      } else if (command === "AUTH") {
        if (!secure) return send("530 5.7.0 required STARTTLS");
        if (parts[0]?.toUpperCase() === "PLAIN") {
          authState = "plain";
          if (parts[1]) smtp(parts[1]);
          else send("334 ");
        } else if (parts[0]?.toUpperCase() === "LOGIN") {
          authState = "user";
          if (parts[1]) smtp(parts[1]);
          else send("334 VXNlcm5hbWU6");
        } else send("504 5.5.4 unsupported authentication");
      } else if (command === "QUIT") {
        send("221 2.0.0 closing");
        socket.end();
      } else if (command === "NOOP" || command === "RSET") {
        send("250 2.0.0 OK");
      } else if (["MAIL", "RCPT", "DATA"].includes(command)) {
        if (!authenticated) return send("530 5.7.0 authenticate first");
        if (command === "DATA") {
          smtpData = true;
          send("354 end with dot");
        } else send("250 2.0.0 OK");
      } else send("502 5.5.1 unsupported fixture command");
    }
    function onData(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length > 1048576) return socket.destroy();
      while (true) {
        if (literal) {
          if (buffer.length < literal.bytes + 2) return;
          const raw = buffer.subarray(0, literal.bytes);
          buffer = buffer.subarray(literal.bytes + 2);
          const committed = appendMessage(literal.mailbox, raw, literal.flags);
          const pending = literal;
          literal = null;
          if (!committed) {
            send(`${pending.tag} NO mailbox unavailable`);
            continue;
          }
          if (interruptAppendPending) {
            interruptAppendPending = false;
            counts.interruptedAppends++;
            socket.destroy();
            return;
          }
          send(`${pending.tag} OK appended`);
          continue;
        }
        const position = buffer.indexOf("\r\n");
        if (position < 0) return;
        const line = buffer.subarray(0, position).toString("utf8");
        buffer = buffer.subarray(position + 2);
        if (protocol === "imap") imap(line);
        else smtp(line);
      }
    }
    socket.on("data", onData);
    send(
      protocol === "imap"
        ? "* OK compatibility fixture"
        : "220 fixture.example.test ESMTP",
    );
  }
  async function start() {
    if (servers.length) throw new Error("Fixture is already running.");
    try {
      for (const protocol of ["imap", "smtp"]) {
        const accept = (socket) => session(socket, protocol);
        const server =
          tlsMode === "tls"
            ? tls.createServer(options, accept)
            : net.createServer(accept);
        server.on("tlsClientError", () => {});
        server.on("connection", (socket) => {
          sockets.add(socket);
          socket.on("error", () => socket.destroy());
          socket.on("close", () => sockets.delete(socket));
        });
        server.listen(ports[protocol], "127.0.0.1");
        await once(server, "listening");
        servers.push(server);
        ports[protocol] = server.address().port;
      }
    } catch (error) {
      await stop();
      throw error;
    }
    return { ...ports };
  }
  async function stop() {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise((resolve) => server.close(resolve))),
    );
  }
  return {
    start,
    stop,
    restart: async () => {
      await stop();
      return start();
    },
    ports: () => ({ ...ports }),
    results: () => ({ ...counts }),
  };
}

// This probe validates the fixture transport, not Postal Snap compatibility.
export async function probeCompatibilityFixture({ certificatePath, keyPath }) {
  const ca = await readFile(certificatePath);
  const scenarios = [];
  for (const tlsMode of ["tls", "startTls"]) {
    const fixture = await createCompatibilityFixture({
      certificatePath,
      keyPath,
      tlsMode,
    });
    try {
      const ports = await fixture.start();
      for (const protocol of ["imap", "smtp"]) {
        let socket =
          tlsMode === "tls"
            ? tls.connect({ host: "127.0.0.1", port: ports[protocol], ca })
            : net.connect({ host: "127.0.0.1", port: ports[protocol] });
        const lines = (current) => {
          let buffer = "";
          const waiting = [];
          const ready = [];
          function data(chunk) {
            buffer += chunk.toString();
            while (buffer.includes("\r\n")) {
              const index = buffer.indexOf("\r\n");
              const line = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              if (waiting.length) waiting.shift()(line);
              else ready.push(line);
            }
          }
          current.on("data", data);
          return {
            read: async () =>
              ready.length
                ? ready.shift()
                : new Promise((resolve) => waiting.push(resolve)),
            detach: () => current.removeListener("data", data),
          };
        };
        socket.on("error", () => {});
        const deadline = setTimeout(
          () => socket.destroy(new Error("Fixture probe timed out.")),
          5000,
        );
        try {
          let reader = lines(socket);
          const read = () =>
            new Promise((resolve, reject) => {
              const failed = () => {
                cleanup();
                reject(new Error("Fixture probe connection failed."));
              };
              const cleanup = () => {
                socket.removeListener("error", failed);
                socket.removeListener("close", failed);
              };
              socket.once("error", failed);
              socket.once("close", failed);
              reader.read().then((line) => {
                cleanup();
                resolve(line);
              });
            });
          assert.match(await read(), protocol === "imap" ? /^\* OK/ : /^220/);
          if (tlsMode === "startTls") {
            socket.write(
              protocol === "imap"
                ? 'z LOGIN "fixture@example.test" "fixture-password"\r\n'
                : "AUTH LOGIN\r\n",
            );
            assert.match(
              await read(),
              protocol === "imap" ? /^z NO required STARTTLS/ : /^530/,
            );
            socket.write(
              protocol === "imap" ? "a STARTTLS\r\n" : "STARTTLS\r\n",
            );
            assert.match(await read(), protocol === "imap" ? /^a OK/ : /^220/);
            reader.detach();
            socket = tls.connect({
              socket,
              ca,
              rejectUnauthorized: true,
              servername: "localhost",
            });
            socket.on("error", () => {});
            reader = lines(socket);
            await once(socket, "secureConnect");
          }
          if (protocol === "imap") {
            socket.write("x CAPABILITY\r\n");
            const capabilityLine = await read();
            assert.equal(capabilityLine, "* CAPABILITY IMAP4rev1");
            assert.match(await read(), /^x OK/);
            socket.write('w LOGIN "fixture@example.test" "wrong"\r\n');
            assert.match(await read(), /^w NO/);
            socket.write(
              'b LOGIN "fixture@example.test" "fixture-password"\r\n',
            );
            assert.match(await read(), /^b OK/);
            socket.write("c ENABLE QRESYNC\r\n");
            assert.match(await read(), /^c BAD/);
          } else {
            socket.write("AUTH LOGIN\r\n");
            assert.match(await read(), /^334/);
            socket.write(
              `${Buffer.from("fixture@example.test").toString("base64")}\r\n`,
            );
            assert.match(await read(), /^334/);
            socket.write(`${Buffer.from("wrong").toString("base64")}\r\n`);
            assert.match(await read(), /^535/);
            const token = Buffer.from(
              "\0fixture@example.test\0fixture-password",
            ).toString("base64");
            socket.write(`AUTH PLAIN ${token}\r\n`);
            assert.match(await read(), /^235/);
          }
          scenarios.push({ name: `${protocol}-${tlsMode}`, status: "passed" });
        } finally {
          clearTimeout(deadline);
          socket.destroy();
        }
      }
      await fixture.restart();
      scenarios.push({ name: `restart-${tlsMode}`, status: "passed" });
    } finally {
      await fixture.stop();
    }
  }
  return scenarios;
}
