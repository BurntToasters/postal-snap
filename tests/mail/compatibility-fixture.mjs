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
  };
  let ports = { imap: imapPort, smtp: smtpPort };

  function session(initialSocket, protocol) {
    let socket = initialSocket;
    let secure = tlsMode === "tls";
    let authenticated = false;
    let buffer = "";
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
      buffer = "";
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
              await start();
              counts.restarts++;
            } catch {
              counts.restartFailed = true;
            }
          });
        });
      } else if (command === "ENABLE") {
        if (rejectEnable) send(`${tag} BAD extension unavailable`);
        else {
          send(`* ENABLED ${args}`);
          send(`${tag} OK enabled`);
        }
      } else if (command === "NOOP") {
        send(`${tag} OK noop`);
      } else if (command === "LIST" || command === "LSUB") {
        for (const name of ["INBOX", "Labels", "Labels/Project", "All Mail"]) {
          send(`* ${command} () "/" "${name}"`);
        }
        send(`${tag} OK listed`);
      } else if (command === "SELECT" || command === "EXAMINE") {
        send("* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)");
        send("* 0 EXISTS");
        send("* OK [UIDVALIDITY 1] generation");
        send("* OK [UIDNEXT 1] next");
        send(`${tag} OK [READ-WRITE] selected`);
      } else if (command === "UID" && /^SEARCH\b/i.test(args)) {
        send("* SEARCH");
        send(`${tag} OK searched`);
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
      buffer += chunk.toString();
      if (buffer.length > 1048576) return socket.destroy();
      while (buffer.includes("\r\n")) {
        const position = buffer.indexOf("\r\n");
        const line = buffer.slice(0, position);
        buffer = buffer.slice(position + 2);
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
