# AI Inbox CRM Netlify Deploy

Deploy this folder through Git or Netlify CLI so Netlify can install dependencies and bundle the serverless function.

After deploy, set these environment variables in Netlify:

- `META_VERIFY_TOKEN` - any secret string. Use the same value in Meta webhook setup.
- `META_APP_SECRET` - optional, but recommended. Enables `X-Hub-Signature-256` verification.
- `META_GRAPH_VERSION` - for example `v23.0`.
- `FB_PAGE_ACCESS_TOKEN` - Facebook Page access token for Messenger replies.
- `WHATSAPP_ACCESS_TOKEN` - WhatsApp Cloud API access token.
- `WHATSAPP_PHONE_NUMBER_ID` - WhatsApp Cloud API phone number ID.
- `WHATSAPP_TEST_RECIPIENT_PHONE` - optional test recipient phone from Meta, digits only.
- `OPENAI_API_KEY` - optional. If empty, the bot returns demo AI replies.
- `OPENAI_MODEL` - OpenAI model name.
- `AI_SYSTEM_PROMPT` - base support-agent prompt.

Use this webhook URL in Meta:

```text
https://YOUR-NETLIFY-SITE.netlify.app/webhooks/meta
```

The CRM UI is available at:

```text
https://YOUR-NETLIFY-SITE.netlify.app/
```

For a quick check without Meta, open the UI and use the "simulate" form.

Dialog storage check:

```text
https://YOUR-NETLIFY-SITE.netlify.app/api/storage
```

The response should include:

```json
{
  "provider": "netlify-blobs",
  "persistent": true
}
```

If Netlify returns an error saying Blobs needs `siteID` and `token`, add:

- `NETLIFY_SITE_ID` - Netlify Project ID from Project configuration > General > Project information.
- `NETLIFY_BLOBS_TOKEN` - Netlify personal access token from User settings > Applications > Personal access tokens.

Recommended deploy options:

```powershell
netlify deploy --prod --dir public --functions netlify/functions
```

Or connect this folder/repository to Netlify with:

```text
Build command: npm install
Publish directory: public
Functions directory: netlify/functions
```
