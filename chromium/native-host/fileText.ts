/**
 * Text out of a document the user attached to a companion (shared/knowledge.ts), using what
 * macOS already has: PDFKit (through JavaScript for Automation) for PDFs and `textutil` for
 * Word, RTF, OpenDocument and HTML files. Nothing is installed or downloaded, and nothing
 * leaves the Mac.
 *
 * The bytes are written to a private temporary file (mode 600, in a folder only this user can
 * read), converted, and the file is deleted whatever happens. Only fixed programs run, with the
 * path as an argument (never through a shell), and each gets 30 seconds. The document's text is
 * never logged.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_FILE_BYTES, cleanFileText, extOf, kindOf, type ExtractReply, type ExtractRequest } from '../shared/knowledge';

/** Reads a PDF's text with PDFKit; argv[0] is the path. Prints nothing for a PDF without text (a scan). */
const PDF_SCRIPT = `ObjC.import('PDFKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) throw new Error('not a PDF');
  const text = doc.string;
  return text && !text.isNil() ? text.js : '';
}`;

type Run = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<string>;

const run: Run = (file, args, options) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { ...options, encoding: 'utf8' }, (err: Error | null, stdout: string) => (err ? reject(err) : resolve(String(stdout)))),
  );

export async function extractText(request: ExtractRequest, exec: Run = run): Promise<ExtractReply> {
  const name = typeof request?.name === 'string' ? request.name : '';
  const kind = kindOf(name);
  if (!kind) return { error: 'UrAnus Browser can read PDFs, Word, RTF, OpenDocument, HTML and plain-text files.' };
  if (typeof request.data !== 'string') return { error: 'The file didn’t arrive.' };
  const bytes = Buffer.from(request.data, 'base64');
  if (!bytes.length) return { error: 'The file is empty.' };
  if (bytes.length > MAX_FILE_BYTES) return { error: `The file is too big (the limit is ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).` };
  if (kind === 'text') return cleanFileText(bytes.toString('utf8'));
  if (process.platform !== 'darwin') return { error: 'Reading PDFs and documents needs macOS.' };

  const dir = await mkdtemp(path.join(os.tmpdir(), 'anus-file-'));
  // The name on disk is ours: only the extension comes from the user's file, and only a checked one.
  const file = path.join(dir, `${randomUUID()}.${extOf(name)}`);
  try {
    await writeFile(file, bytes, { mode: 0o600 });
    const options = { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 };
    const text =
      kind === 'pdf'
        ? await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_SCRIPT, file], options)
        : await exec('/usr/bin/textutil', ['-convert', 'txt', '-stdout', file], options);
    return cleanFileText(text);
  } catch {
    return { error: kind === 'pdf' ? 'That PDF couldn’t be read. Is it password-protected or damaged?' : 'That document couldn’t be read.' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
