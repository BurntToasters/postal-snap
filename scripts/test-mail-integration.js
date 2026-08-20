import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { process, root, run } from "./_utils.js";

try {
  await run("docker", ["compose", "version"]);
} catch {
  throw new Error(
    "Docker with Compose is required for npm run test:mail-integration.",
  );
}
try {
  await run("openssl", ["version"]);
} catch {
  throw new Error("OpenSSL is required for npm run test:mail-integration.");
}

const temporary = await mkdtemp(join(tmpdir(), "postal-snap-mail-test-"));
const key = join(temporary, "server.key");
const certificate = join(temporary, "server.pem");
const store = join(temporary, "server.p12");
const compose = join(root, "tests/mail/docker-compose.yml");
const project = "postal-snap-mail-test";
const environment = {
  ...process.env,
  POSTAL_SNAP_GREENMAIL_P12: store,
};

try {
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    certificate,
    "-days",
    "2",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  await run("openssl", [
    "pkcs12",
    "-export",
    "-in",
    certificate,
    "-inkey",
    key,
    "-out",
    store,
    "-name",
    "postal-snap-greenmail",
    "-passout",
    "pass:changeit",
  ]);
  await run("docker", ["compose", "-p", project, "-f", compose, "up", "-d"], {
    env: environment,
  });
  await Promise.all([waitForPort(3025), waitForPort(3993)]);
  await run(
    "cargo",
    [
      "test",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "greenmail_protocol_integration",
      "--",
      "--ignored",
      "--nocapture",
    ],
    {
      env: {
        ...environment,
        POSTAL_SNAP_MAIL_INTEGRATION: "1",
        POSTAL_SNAP_MAIL_TEST_CA_CERT: certificate,
      },
    },
  );
} finally {
  await run(
    "docker",
    ["compose", "-p", project, "-f", compose, "down", "--volumes"],
    { env: environment },
  ).catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}

async function waitForPort(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await portIsOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`GreenMail port ${port} did not become ready.`);
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}
