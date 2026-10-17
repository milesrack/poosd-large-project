import { ACCOUNT_EMAIL_TTL } from "./email-policy.ts";

export async function sendAccountEmail(
  to: string,
  url: string,
  kind: keyof typeof ACCOUNT_EMAIL_TTL,
) {
  const verify = kind === "verification";
  const subject = verify
    ? "Verify your Zetafly email"
    : "Reset your Zetafly password";
  const title = verify ? "Verify your email" : "Reset your password";
  const action = verify ? "Verify email" : "Reset password";
  const minutes = ACCOUNT_EMAIL_TTL[kind] / 60;
  const expiry = minutes === 60 ? "1 hour" : `${minutes} minutes`;
  const instruction = verify
    ? "Confirm your email address to finish creating your Zetafly account."
    : "Choose a new password for your Zetafly account.";
  const text = `${title}\n\n${instruction}\n\n${url}\n\nThis link expires in ${expiry}. If you didn’t request this email, you can ignore it.`;
  const escaped = url
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
  const html = /* HTML */ `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
      </head>
      <body
        style="margin:0;background:#fff;color:#20242c;font-family:Arial,sans-serif"
      >
        <table role="presentation" style="width:100%;border:0;border-spacing:0">
          <tr>
            <td style="padding:48px 24px">
              <table
                role="presentation"
                style="width:100%;max-width:440px;margin:auto;border:0;border-spacing:0"
              >
                <tr>
                  <td>
                    <p style="margin:0 0 32px;font-size:16px;font-weight:600">
                      zetafly
                    </p>
                    <h1 style="margin:0 0 16px;font-size:24px;line-height:1.3">
                      ${title}
                    </h1>
                    <p style="margin:0 0 24px;font-size:15px;line-height:1.6">
                      ${instruction}
                    </p>
                    <table
                      role="presentation"
                      style="border:0;border-spacing:0"
                    >
                      <tr>
                        <td style="background:#20242c;border-radius:6px">
                          <a
                            href="${escaped}"
                            style="display:inline-block;padding:13px 22px;color:#fff;text-decoration:none;font-size:14px;font-weight:600"
                            >${action}</a
                          >
                        </td>
                      </tr>
                    </table>
                    <p style="margin:20px 0 0;font-size:15px;line-height:1.6">
                      Or copy this link into your browser:<br /><a
                        href="${escaped}"
                        style="color:#20242c;word-break:break-all"
                        >${escaped}</a
                      >
                    </p>
                    <p
                      style="margin:24px 0;font-size:13px;line-height:1.6;color:#69717d"
                    >
                      This link expires in ${expiry}. If you didn’t request this
                      email, you can ignore it.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>`;
  const from = process.env.EMAIL_FROM ?? "Zetafly <hello@zetafly.local>";
  let response: Response;

  if (process.env.RESEND_API_KEY) {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(15000),
    });
  } else {
    const match = from.match(/^(.*?)\s*<([^>]+)>$/);
    const sender = match
      ? { Name: match[1].trim(), Email: match[2] }
      : { Email: from };

    response = await fetch(
      `${process.env.MAILPIT_URL ?? "http://localhost:8025"}/api/v1/send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          From: sender,
          To: [{ Email: to }],
          Subject: subject,
          Text: text,
          HTML: html,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
  }

  if (!response.ok) {
    throw new Error("Account email delivery failed");
  }
}
