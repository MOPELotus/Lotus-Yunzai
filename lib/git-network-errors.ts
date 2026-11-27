export function retryableGitFetchFailure(stderr: string, timedOut = false): boolean {
  if (/authentication failed|permission denied|repository not found|couldn't find remote ref|invalid refspec|not (?:a )?git repository|corrupt object|bad object/i.test(stderr)) return false;
  return timedOut || /ECONNRESET|connection (?:reset|refused|closed)|remote end hung up|(?:TLS|SSL|gnutls)[^\r\n]*(?:handshake|connection[^\r\n]*non-properly terminated)|could not resolve host|failed to connect|time[ -]?out|timed out|early EOF|curl\s*(?::\s*)?\(?\s*(?:18|28|35|52|56|92)\b|(?:HTTP(?:\/[\d.]+)?|returned error:|status(?: code)?)[^\r\n]*?\b(?:429|5\d{2})\b/i.test(stderr);
}
