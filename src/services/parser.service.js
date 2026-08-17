import { extractEmail, extractEmails } from "../extractors/emailExtractor.js";

class ParserService {
  /**
   * Extraction is a model call, so this is async — every caller must await it.
   * Resolves to null when the mail is neither courier nor subscription, and
   * rejects when the API call itself fails (so the caller can requeue).
   */
  parse(rawEmail, options = {}) {
    return extractEmail(rawEmail, options);
  }

  /**
   * Batch variant with bounded concurrency — use this instead of mapping
   * parse() over a list, which would fire one request per email at once.
   * Returns an array aligned with `list`; failures land in `errors`.
   */
  parseMany(rawEmails, options = {}) {
    return extractEmails(rawEmails, options);
  }
}

export default new ParserService();
