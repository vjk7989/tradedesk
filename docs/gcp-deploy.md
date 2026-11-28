# GCP deploy guide

Recorded from the first real deploy (2026-11-28): one Compute Engine VM, static IP, Caddy with Let's Encrypt on `sslip.io` (no DNS needed). Replace `<PROJECT>`, `<IP>`, `<DOMAIN>`, `<EMAIL>`. For the generic steps and hardening see [vps-runbook.md](vps-runbook.md).

## 1. gcloud CLI
Install from https://cloud.google.com/sdk/docs/install. On Windows, if `winget` fails, download the zip, extract it and run `install.bat --quiet`.
```
gcloud auth login
gcloud config set project <PROJECT>
```
Billing must be enabled on `<PROJECT>`.

## 2. Enable Compute
```
gcloud services enable compute.googleapis.com
```

## 3. Static IP
```
gcloud compute addresses create tradedesk-ip --region asia-south1
gcloud compute addresses describe tradedesk-ip --region asia-south1 --format='value(address)'
```
The second command prints `<IP>`. Whitelist it in your broker app and on the Delta Exchange API key, or orders are rejected.

## 4. Firewall
```
gcloud compute firewall-rules create tradedesk-web --network default --direction INGRESS --action allow --rules tcp:80,tcp:443 --target-tags tradedesk --source-ranges 0.0.0.0/0
```
No port 22 rule is added by us. SSH goes through OS Login keys (`gcloud compute ssh` uploads yours).

## 5. VM
```
gcloud compute instances create tradedesk-vm --zone asia-south1-a --machine-type e2-medium --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud --boot-disk-size 40GB --boot-disk-type pd-balanced --tags tradedesk --address <IP> --metadata enable-oslogin=TRUE
gcloud compute ssh tradedesk-vm --zone asia-south1-a
```
Cost: about $30-35 a month for e2-medium plus the static IP.

## 6. Domain without DNS
Use `sslip.io`: `<IP>` with dashes, for example IP 1.2.3.4 gives:
```
DOMAIN=1-2-3-4.sslip.io
```
Caddy then serves `openalgo.<DOMAIN>`, `mcp.<DOMAIN>` and `dash.<DOMAIN>` ([deploy/Caddyfile](../deploy/Caddyfile)) with real certificates. `ACME_EMAIL` is required; compose refuses to start without it.

## 7. On the VM: Docker and `.env`
```
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER      # then log out and back in
git clone https://github.com/vjk7989/tradedesk && cd tradedesk/deploy
cp .env.example .env
```
Generate secrets and set the domain:
```
sed -i "s/^MCP_TOKEN=.*/MCP_TOKEN=$(openssl rand -hex 32)/; s/^BT_TOKEN=.*/BT_TOKEN=$(openssl rand -hex 32)/" .env
sed -i "s/^DOMAIN=.*/DOMAIN=<DOMAIN>/; s/^ACME_EMAIL=.*/ACME_EMAIL=<EMAIL>/" .env
```
Dashboard password (note it somewhere safe) and its bcrypt hash:
```
PW=$(openssl rand -base64 18); echo "$PW"
docker run --rm caddy:2-alpine caddy hash-password --plaintext "$PW"
```
Put the hash in `.env` **in single quotes**, otherwise compose interpolates the `$` signs:
```
DASH_PASSWORD_HASH='<bcrypt-hash>'
```
Then:
```
chmod 600 .env
```
`OPENALGO_API_KEY` may stay a placeholder until step 10. Keep `MODE=paper`.

## 8. OpenAlgo
Still in `deploy/`. The pinned commit is the one in [vps-runbook.md](vps-runbook.md) section 4.
```
git clone https://github.com/marketcalls/openalgo ../vendor/openalgo
git -C ../vendor/openalgo checkout f83592a
cp ../vendor/openalgo/.sample.env openalgo.env
```
Edit `openalgo.env`:
```
HOST_SERVER='https://openalgo.<DOMAIN>'
FLASK_HOST_IP='0.0.0.0'
WEBSOCKET_HOST='0.0.0.0'
WEBSOCKET_URL='wss://openalgo.<DOMAIN>/ws'
REDIRECT_URL='https://openalgo.<DOMAIN>/<broker>/callback'
```
Then make the file owned by uid 1000:
```
chmod 600 openalgo.env
sudo chown 1000 openalgo.env
```
**Do not skip the chown.** Without it OpenAlgo restart-loops with ".env file not found" (it writes generated keys back to the bind-mounted file).

## 9. Start
```
docker compose up -d --build
docker compose ps
```
The first build takes about 10 minutes on e2-medium. Check `curl https://mcp.<DOMAIN>/healthz`.

## 10. OpenAlgo API key
1. Open `https://openalgo.<DOMAIN>`, create the admin account and log in.
2. Open the API Key page and generate a key.
3. Put it in `.env` and restart trade-mcp:
```
sed -i "s/^OPENALGO_API_KEY=.*/OPENALGO_API_KEY=<key>/" .env
docker compose up -d trade-mcp
```
Broker login and going live: [vps-runbook.md](vps-runbook.md) sections 7 and 10.

## 11. Connect Claude Code
On your own machine, with `MCP_TOKEN` exported to the value from the VM's `.env`:
```
claude mcp add --scope user --transport http tradedesk https://mcp.<DOMAIN>/mcp --header "Authorization: Bearer $MCP_TOKEN"
claude mcp list
```
Other clients: [connect-clients.md](connect-clients.md).

## 12. Gotchas from the first deploy
| Symptom | Cause | Status |
|---|---|---|
| paper-bot could not reach the exchange | service had no egress network | fixed by PB-3 (#103); `git pull` |
| every backtest failed with EACCES | bt-service `/runs` tmpfs was root-owned | fixed by PB-5 (#110); `git pull` |
| paper-bot log full of "already processed" | `INTERVAL_SEC` below the candle period (`RESOLUTION`) | keep `INTERVAL_SEC` >= the period (PB-4 sets 300) |
| OpenAlgo restart loop, ".env file not found" | `openalgo.env` not owned by uid 1000 | `sudo chown 1000 openalgo.env`, `docker compose up -d openalgo` |
| compose error on `DASH_PASSWORD_HASH` / dashboard login fails | hash not single-quoted | quote it as in step 7 |

## 13. Update, backup, teardown
Update (from `deploy/`):
```
git pull && docker compose up -d --build
```
Backups: see [backup.md](backup.md). For scheduled, encrypted off-site copies to a GCS
bucket (upload-only service account, daily 02:30 IST timer), follow "Off-site copy to
Google Cloud Storage" there.

Teardown (this deletes the VM and its disk, and releases the IP):
```
gcloud compute instances delete tradedesk-vm --zone asia-south1-a
gcloud compute addresses delete tradedesk-ip --region asia-south1
gcloud compute firewall-rules delete tradedesk-web
```
