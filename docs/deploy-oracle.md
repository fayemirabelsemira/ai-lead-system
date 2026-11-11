# Putting the system online: Oracle Cloud "Always Free"

Result: your backend runs 24/7 on a free Oracle server, your form has a public
HTTPS address like `https://129-150-1-2.sslip.io/f/<form id>`, and your laptop
no longer needs to be on.

Time: about 1-2 hours the first time. You need: a card (Oracle uses it to
verify you; Always Free resources are not charged), your laptop's `.env` values.

> Written without live access to Oracle's site. Oracle changes its screens and
> free-tier rules; if something differs, follow Oracle's wording and ask.
> Check on Oracle's "Always Free Resources" page: the free server shapes and
> the rule about reclaiming idle servers (step 9).

## 1. Create the account
1. Go to oracle.com/cloud/free and sign up.
2. **Home region: Singapore** (closest to the Philippines). It cannot be
   changed later, and Always Free servers only run in the home region.
3. Wait for the "account is ready" email (minutes to a few hours).

## 2. Create the server
Menu -> Compute -> Instances -> **Create instance**
- Name: `ai-lead`
- Image: **Canonical Ubuntu 24.04**
- Shape: **VM.Standard.E2.1.Micro** (AMD, "Always Free-eligible"). 1 GB of
  memory is enough for this app. If you prefer Ampere (A1, more power), use
  1 OCPU / 6 GB; A1 is often "out of capacity" in Singapore, so Micro is the
  reliable choice.
- Networking: create a new virtual cloud network with a **public subnet**, and
  **assign a public IPv4 address**.
- SSH keys: **Generate a key pair for me** -> **Save private key**.
  On your Mac:
  ```bash
  mkdir -p ~/.ssh && mv ~/Downloads/ssh-key-*.key ~/.ssh/oracle-ai-lead.key && chmod 600 ~/.ssh/oracle-ai-lead.key
  ```
  Keep this file private: it is the key to your server.
- Create. When it is "Running", copy its **Public IP address**.

## 3. Open the web ports in Oracle
Instance page -> the subnet link -> **Security Lists** -> Default Security List
-> **Add Ingress Rules**, twice:
- Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port `80`
- Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port `443`

(Port 22 for SSH is already open.)

## 4. Your public address
No domain needed: take the IP and replace the dots with dashes, then add
`.sslip.io`. IP `129.150.1.2` -> **`129-150-1-2.sslip.io`**. Caddy gets a free
HTTPS certificate for it automatically. (You can switch to your own domain
later.)

## 5. Copy the setup script to the server and connect
On your Mac, in the project folder (replace the IP):
```bash
scp -i ~/.ssh/oracle-ai-lead.key deploy/setup.sh ubuntu@129.150.1.2:
```
```bash
ssh -i ~/.ssh/oracle-ai-lead.key ubuntu@129.150.1.2
```
Answer `yes` the first time. You are now on the server.

## 6. Run the setup (three rounds)
On the server:
```bash
bash setup.sh 129-150-1-2.sslip.io
```
**Round 1** installs everything, then prints a key starting with `ssh-ed25519`.
Add it on GitHub: your repository -> Settings -> **Deploy keys** -> Add deploy
key. Title `oracle-server`, paste the key, leave **Allow write access
unticked**. Run the same command again.

**Round 2** downloads the code and creates the settings file, then lists what
to fill in. Open it:
```bash
sudo nano /etc/ai-lead/env
```
Copy the values from your laptop's `.env` (Supabase URL and secret key, Groq
key and model, Telegram bot token, Gmail user and app password). Save with
Ctrl+O, Enter, and exit with Ctrl+X.

**Before round 3: stop the laptop copy.** In the terminal running
`npm run dev`, press Ctrl+C. The bot can run in only one place.

**Round 3** starts the app and checks `https://<address>/health`. If it says
"Online", you are live.

## 7. Get your form link and test
```bash
sudo journalctl -u ai-lead | grep 'Form ('
```
Open the link on your phone **using mobile data** (not Wi-Fi), send an
inquiry, and check that the card arrives in Telegram.

## 8. Everyday commands (on the server)
| What | Command |
|---|---|
| Is it running? | `sudo systemctl status ai-lead` |
| Live log | `sudo journalctl -u ai-lead -f` (Ctrl+C to stop watching) |
| Restart | `sudo systemctl restart ai-lead` |
| Put new code online | `bash /opt/ai-lead-system/deploy/update.sh` |
| Change settings | `sudo nano /etc/ai-lead/env`, then restart |
| Add/update a business | `cd /opt/ai-lead-system/backend && sudo -u ailead node --env-file=/etc/ai-lead/env scripts/add-business.js /path/to/business.json` (or keep running add-business on your laptop: it only talks to Supabase) |

Updating: commit and push on your laptop -> on the server run `update.sh`.
If the update has a new `supabase/migrations/` file, run it in the Supabase
SQL Editor **first**.

The app restarts by itself if it crashes and starts again after a server reboot.

To test changes on your laptop later: stop the server app first
(`sudo systemctl stop ai-lead`), run `npm run dev`, then stop it and
`sudo systemctl start ai-lead`.

## 9. Keep the free server from being taken back
Oracle may reclaim Always Free servers that sit **idle** for 7 days (very low
CPU, network and memory use). This app is light, so it can look idle.
The usual fix: **upgrade the account to Pay As You Go** (Billing -> Upgrade).
Always Free resources stay free; you pay only if you create paid resources.
Then set a budget alert (Billing -> Budgets) at a small amount, e.g. USD 1, so
you are emailed if anything ever costs money. Check Oracle's current rules
when you do this.

## Troubleshooting
- **`/health` does not answer**: check the Security List rules (step 3), then
  `sudo journalctl -u caddy -n 50`. A certificate error usually means port 80
  is not open.
- **"Conflict: terminated by other getUpdates request"** in the log: the bot
  is also running on your laptop. Stop that one.
- **"Missing or placeholder environment variable"**: a value in
  `/etc/ai-lead/env` is still empty or `your-...`.
- **"Recovery is OFF: run ...012_recovery.sql"**: run that migration in Supabase.
- **Emails fail**: the log line says why; the owner also gets a Telegram
  message with the reply to send by hand.
