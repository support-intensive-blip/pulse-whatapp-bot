# Connecting a Gupshup number

In Pulse, choose AI Bots → Connect WhatsApp number → WhatsApp provider → Gupshup.
Enter the phone with country code, API key and exact Gupshup app name registered for that phone.
The app name is not the WhatsApp display name, WABA ID or phone number ID.
Choose a long random webhook secret and save the bot. Keep the bot paused until callback setup is finished.

In Gupshup Converse, open Channels → WhatsApp → Webhooks → Add Webhook.
Copy the complete callback URL from Pulse's Integration tab, including its token.
Use the Cloudflare dashboard host for the callback so it can accept messages while Render sleeps.
Select Gupshup format (v2), and the Message event. Save the webhook.
Send a message from a test number and check the bot's last received time, then activate its AI.

## Getting credentials

Use the API key and app name from the Gupshup WhatsApp API application linked to this number.
Some Converse accounts do not expose API credentials in My Profile or Channels → WhatsApp → Account.
In that case ask your Gupshup account manager or support for the WhatsApp Access API app name and API key
for the existing number, and confirmation that the app can use `https://api.gupshup.io/wa/api/v1/msg`.
Do not create a separate app or migrate the number just to find credentials.
Never use the WABA ID or phone number ID as an app name.

For the production account inspected on November 4, 2026, the console shows phone `919182603532`
(+91 91826 03532), display name Nxtwave Intensive Offline.
The API key and Access API app name were not visible on the inspected profile/account screens.

Reference: https://docs.gupshup.io/reference/msg
Inbound reference: https://console-docs.gupshup.io/docs/inbound-messages-and-events

Pulse encrypts the stored API key. Callback authentication uses the secret token in the URL;
keep that URL private. Cloudflare validates the token and app, then durably saves the event
before acknowledging it. Render processes the event through the same AI pipeline as Gallabox.
The Test connection action checks required fields only; a real inbound/reply test verifies delivery.
