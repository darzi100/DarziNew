# Darzi: custom tailoring platform (Delhi)

Run:  `node server.js`  then open http://localhost:3000  (Node 22+, no npm install needed)
Test: `npm test`

Demo logins (mobile numbers; the OTP is shown on screen in test mode):
- Admin:    9000000001
- Tailor:   9000000011 (Ramesh Tailors), 9000000012 (Sunita Boutique)
- Customer: 9000000021

Test modes (clearly labelled in the UI):
- OTP: test mode shows the code on screen. For real SMS set OTP_MODE=sms plus FAST2SMS_API_KEY, FAST2SMS_SENDER_ID and
  FAST2SMS_MESSAGE_ID (from your Fast2SMS panel, DLT-approved sender and OTP template with one {#var#}). Untested against the live provider.
- Payments: test mode until RAZORPAY_KEY_ID / secret are set as environment variables.

Production: set NODE_ENV=production and APP_SECRET, SEED_DEMO=0, ADMIN_MOBILE=<your number>.
Data is stored in ./data (SQLite). Move to PostgreSQL before scaling; db.js is the only schema file.

## Pay on delivery (UPI / cash)
At payment the customer can choose "Pay on delivery". The order is confirmed and the admin can assign a tailor.
When the money arrives the admin opens the order and clicks "Record payment received" (cash or UPI).
The order cannot be marked Delivered until the payment is recorded.

## Sharing with other phones (free): Cloudflare quick tunnel
1. Start Darzi:            node server.js
2. Install cloudflared from https://developers.cloudflare.com/tunnel/downloads/
3. In a second terminal:   cloudflared tunnel --url http://localhost:3000
4. It prints a https://....trycloudflare.com link. Open it on any phone. The link changes every time.
Keep both windows open. Your computer must stay on. No Cloudflare account is needed.
Test-mode OTPs for admin and tailor accounts are NOT shown on screen over the tunnel; they are printed in the
server window ("[TEST OTP] ..."). Customer OTPs are still shown on screen in test mode, so only share the link
with people you know, and do not use real SMS/payments until an adult owner has set those up.
