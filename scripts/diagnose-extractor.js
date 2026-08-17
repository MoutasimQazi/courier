/**
 * Standalone extractor diagnostic.
 *
 *   node scripts/diagnose-extractor.js
 *
 * Answers, in order, the questions that an empty /api/emails/sync response
 * cannot distinguish between:
 *
 *   1. Is DEEPSEEK_API_KEY present in this process's environment?
 *   2. Does the configured model accept the request body we send?
 *   3. Does it return JSON we can parse, within the token budget?
 *   4. Does a known courier email survive the confidence + evidence gates?
 *
 * Makes exactly two real API calls. Prints the raw reply on failure so the
 * actual error text from DeepSeek is visible rather than a generic message.
 */

import "../src/config/env.js";
import { extractEmail } from "../src/extractors/emailExtractor.js";

const line = (label, value) => console.log(`${label.padEnd(22)} ${value}`);

const COURIER_SAMPLE = {
  id: "diagnostic-courier",
  date: new Date().toISOString(),
  subject: "Your Sony WH-1000XM5 has shipped - Order ORD-99182",
  body: `<html><body>
    <img src="https://cdn.example.com/tracking/pixel.gif" width="1" height="1">
    <img src="https://cdn.example.com/products/sony-wh1000xm5.jpg" width="400" height="400">
    <p>Good news - order <b>ORD-99182</b> placed on 10 August 2026 is on its way.</p>
    <p>Item: Sony WH-1000XM5 Wireless Headphones</p>
    <p>Total paid: Rs. 26,990.00</p>
    <p>Carrier: Blue Dart. Tracking number: BD48120076.</p>
    <p>Estimated delivery: 18 August 2026.</p>
    <p><a href="https://www.bluedart.com/track?awb=BD48120076">Track your parcel</a></p>
    <p><a href="https://example.com/unsubscribe">Unsubscribe</a></p>
  </body></html>`,
  from_attendee: { display_name: "Example Store", identifier: "no-reply@example-store.com" },
  to_attendees: [{ display_name: "Customer", identifier: "customer@example.com" }],
};

const MARKETING_SAMPLE = {
  id: "diagnostic-marketing",
  date: new Date().toISOString(),
  subject: "FREE SHIPPING all weekend + manage your subscription preferences",
  body: `<html><body>
    <p>Enjoy free delivery on every order this weekend! Shop the sale now.</p>
    <p>You are receiving this because you subscribed to our newsletter.</p>
    <p><a href="https://example.com/unsubscribe">Manage your subscription preferences</a></p>
  </body></html>`,
  from_attendee: { display_name: "Example Store", identifier: "marketing@example-store.com" },
};

console.log("\n=== environment ===");
line("DEEPSEEK_API_KEY", process.env.DEEPSEEK_API_KEY ? "set" : "MISSING <- extraction cannot work");
line("DEEPSEEK_MODEL", process.env.DEEPSEEK_MODEL || "deepseek-v4-flash (default)");
line("DEEPSEEK_BASE_URL", process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com (default)");
line("node", process.version);

if (!process.env.DEEPSEEK_API_KEY) {
  console.log("\nFAILED: set DEEPSEEK_API_KEY in .env, then run this again.\n");
  process.exit(1);
}

let failures = 0;

console.log("\n=== 1. courier email (expected: extracted) ===");
try {
  const started = Date.now();
  const result = await extractEmail(COURIER_SAMPLE);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (!result) {
    failures++;
    console.log(`RESULT: null after ${seconds}s`);
    console.log("The API call succeeded but the mail was rejected. Either the model");
    console.log("returned category 'none', or confidence landed under MIN_CONFIDENCE (6).");
  } else {
    console.log(`RESULT: extracted in ${seconds}s`);
    line("  category", result.category);
    line("  confidence", result.confidence);
    line("  merchant", result.merchant);
    line("  orderNumber", result.order.orderNumber);
    line("  orderName", result.order.orderName);
    line("  items", JSON.stringify(result.order.items));
    line("  orderDate", result.order.orderDate);
    line("  amount", `${result.order.amount} ${result.order.currency}`);
    line("  trackingNumber", result.shipping?.trackingNumber);
    line("  carrier", result.shipping?.carrier);
    line("  status", result.shipping?.status);
    line("  estimatedDelivery", result.shipping?.estimatedDelivery);
    line("  imageUrl", result.imageUrl);
    line("  merchantDomain", result.merchantDomain);
    line("  filter", JSON.stringify(result.filter));

    const missing = [
      ["orderNumber", result.order.orderNumber],
      ["trackingNumber", result.shipping?.trackingNumber],
      ["amount", result.order.amount],
      ["imageUrl", result.imageUrl],
    ].filter(([, v]) => v == null).map(([k]) => k);

    if (missing.length) {
      console.log(`\nNOTE: expected fields came back null: ${missing.join(", ")}`);
    }
  }
} catch (error) {
  failures++;
  console.log("RESULT: threw");
  console.log(`  ${error.message}`);
  if (error.status) line("  http status", error.status);
  console.log("\nA 400 here usually means the model name or a request field was");
  console.log("rejected. Check DEEPSEEK_MODEL and the 'thinking' parameter in");
  console.log("src/extractors/emailExtractor.js against DeepSeek's current API.");
}

console.log("\n=== 2. marketing email (expected: null) ===");
try {
  const result = await extractEmail(MARKETING_SAMPLE);
  if (result) {
    failures++;
    console.log(`RESULT: WRONGLY extracted as ${result.category} (confidence ${result.confidence})`);
    console.log("'Free shipping' plus 'manage your subscription' should classify as none.");
  } else {
    console.log("RESULT: correctly rejected");
  }
} catch (error) {
  failures++;
  console.log(`RESULT: threw - ${error.message}`);
}

console.log(`\n=== ${failures === 0 ? "extraction is working" : `${failures} problem(s) found`} ===\n`);
process.exit(failures === 0 ? 0 : 1);
