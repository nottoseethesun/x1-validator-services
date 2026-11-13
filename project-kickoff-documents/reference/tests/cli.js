/*-
 * Test stand-in for the tool's cli, for the systemd tests only. It has two
 * commands:
 *
 *   decrypt-key --password-stdin   reads the password from standard input and
 *                                  prints the api key, as the start wrapper
 *                                  expects; refuses when output is a terminal
 *   make-vault                     reads "password\nkey" from standard input
 *                                  and writes a vault with that key
 *
 * The vault uses LP Ranger's key-store scheme: PBKDF2-SHA-512 at 600,000
 * iterations, AES-256-GCM, a random 16-byte salt and 12-byte iv per secret.
 * The vault path comes from the account's passwd entry, not from $HOME.
 */
import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';

const VAULT = join(userInfo().homedir, '.config', 'x1-validator-services', 'vault.json');
const SECRET = 'x1-validator-private-rpc/api-key';
const ITERATIONS = 600000;

function deriveKey(password, salt, iterations) {
  return pbkdf2Sync(password, salt, iterations, 32, 'sha512');
}

function encrypt(plain, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt, ITERATIONS), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    version: 1,
    kdf: 'pbkdf2',
    kdfParams: { digest: 'sha512', iterations: ITERATIONS, saltHex: salt.toString('hex') },
    cipher: 'aes-256-gcm',
    ivHex: iv.toString('hex'),
    authTagHex: cipher.getAuthTag().toString('hex'),
    ciphertextHex: ciphertext.toString('hex'),
  };
}

function decrypt(entry, password) {
  const salt = Buffer.from(entry.kdfParams.saltHex, 'hex');
  const key = deriveKey(password, salt, entry.kdfParams.iterations);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(entry.authTagHex, 'hex'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(entry.ciphertextHex, 'hex')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

function readStdin() {
  return readFileSync(0, 'utf8').replace(/\r?\n$/, '');
}

const [command, flag] = process.argv.slice(2);
if (command === 'decrypt-key' && flag === '--password-stdin') {
  if (process.stdout.isTTY === true) {
    console.error('decrypt-key: refusing to print the key to a terminal');
    process.exit(1);
  }
  const vault = JSON.parse(readFileSync(VAULT, 'utf8'));
  try {
    process.stdout.write(decrypt(vault.secrets[SECRET], readStdin()));
  } catch {
    console.error('decrypt-key: wrong password or damaged vault');
    process.exit(1);
  }
} else if (command === 'make-vault') {
  const [password, key] = readStdin().split('\n');
  mkdirSync(dirname(VAULT), { recursive: true, mode: 0o700 });
  const vault = { version: 1, secrets: { [SECRET]: encrypt(key, password) } };
  writeFileSync(VAULT, JSON.stringify(vault, null, 2) + '\n', { mode: 0o600 });
} else {
  console.error('usage: cli.js decrypt-key --password-stdin | make-vault');
  process.exit(2);
}
