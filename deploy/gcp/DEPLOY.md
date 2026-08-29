# Migrate Pulse to Google Cloud (new Gmail + new project)

This bot runs on a **Compute Engine VM** with Docker — same model as AWS EC2.  
**BigQuery is optional** and not required; the app uses **SQLite** on disk.

## 1. Create a new Google account & GCP project

1. Sign in with your **new Gmail** at [Google Cloud Console](https://console.cloud.google.com/).
2. **Create project** → note the **Project ID** (e.g. `pulse-whatsapp-prod-123`).
3. **Billing** → link a billing account (required for Compute Engine).
4. Install [Google Cloud CLI](https://cloud.google.com/sdk/docs/install).

## 2. Authenticate gcloud with the new account

```powershell
gcloud auth login
gcloud auth application-default login
gcloud config set project YOUR_NEW_PROJECT_ID
```

Verify:

```powershell
gcloud config list
```

## 3. Deploy the app to GCP

From the repo root on Windows:

```powershell
.\deploy\gcp\deploy.ps1 -ProjectId YOUR_NEW_PROJECT_ID
```

Optional:

```powershell
.\deploy\gcp\deploy.ps1 -ProjectId YOUR_NEW_PROJECT_ID -Zone asia-south1-a -MachineType e2-medium
```

Default VM: **e2-medium** (2 vCPU, 4 GB RAM) in **Mumbai** (`asia-south1-a`).  
Do **not** use `e2-small` — Chromium + WhatsApp needs at least 4 GB.

## 4. Configure environment on the VM

```powershell
gcloud compute ssh pulse-whatsapp-vm --zone=asia-south1-a
```

On the VM:

```bash
sudo nano /opt/whatsapp-ai-assistant/.env
```

Set at minimum:

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | AI replies |
| `PINECONE_API_KEY` | Team KBs (recommended for multiple teams) |
| `PINECONE_INDEX` | e.g. `pulse-kb` |
| `DASHBOARD_ADMIN_EMAIL` | Login email |
| `DASHBOARD_ADMIN_PASSWORD` | Login password |
| `JWT_SECRET` | Auto-generated on first deploy if missing |

Restart:

```bash
cd /opt/whatsapp-ai-assistant && sudo docker compose restart
```

Open dashboard: `https://<VM_EXTERNAL_IP-with-dashes>.sslip.io` (HTTPS) or run `.\deploy\gcp\setup-https.ps1`

## HTTPS (recommended)

Browser notifications and secure features require **HTTPS**. After deploy:

```powershell
.\deploy\gcp\setup-https.ps1 -ProjectId YOUR_PROJECT_ID
```

This installs **Caddy** on the VM with a free Let's Encrypt certificate. By default the URL is:

`https://pulse.nxtwave.<ip-with-dashes>.sslip.io` (e.g. `https://pulse.nxtwave.34-100-237-29.sslip.io`) → your VM IP

To use your own domain, point a DNS **A record** to the VM IP, then:

```powershell
.\deploy\gcp\setup-https.ps1 -ProjectId YOUR_PROJECT_ID -Domain pulse.yourdomain.com -AdminEmail you@example.com
```

Legacy HTTP URL (direct port, no notifications): `http://<VM_EXTERNAL_IP>:3000`

Get IP:

```powershell
gcloud compute instances describe pulse-whatsapp-vm --zone=asia-south1-a --format="get(networkInterfaces[0].accessConfigs[0].natIP)"
```

## 5. Migrate data from AWS (optional)

If moving from the existing AWS server:

```powershell
.\deploy\gcp\migrate-from-aws.ps1 `
  -GcpProjectId YOUR_NEW_PROJECT_ID `
  -AwsHost 43.205.212.181 `
  -AwsKeyPath "$env:TEMP\pulse-whatsapp-key-fixed.pem"
```

This copies:

- `data/assistant.db` (users, teams, chats, messages)
- `knowledge-base/` PDFs
- WhatsApp session (`wwebjs_auth` volume) so you may not need to scan QR again

## 6. Pinecone on GCP (team KBs)

SSH to GCP VM, add Pinecone vars to `.env`, then:

```bash
cd /opt/whatsapp-ai-assistant
sudo docker compose exec whatsapp-bot npm run pinecone:setup
sudo docker compose exec whatsapp-bot npm run ingest-kb -- --team=1
```

Or use `deploy/aws/setup-pinecone-remote.sh` logic on the GCP VM (same paths under `/opt/whatsapp-ai-assistant`).

## 7. Shut down AWS (after GCP is verified)

1. Confirm GCP dashboard works and WhatsApp is connected.
2. Stop or terminate the old EC2 instance in AWS Console to avoid double billing.

## GCP vs AWS for this app

| | AWS (current) | GCP (new) |
|---|-------------|-----------|
| VM | EC2 `t3.medium` | GCE `e2-medium` |
| Region | `ap-south-1` Mumbai | `asia-south1` Mumbai |
| Deploy script | `deploy/aws/deploy.ps1` | `deploy/gcp/deploy.ps1` |
| SSH | `ssh -i key.pem ubuntu@IP` | `gcloud compute ssh pulse-whatsapp-vm --zone=...` |
| App storage | SQLite on VM disk | Same |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| VM not reachable | Check firewall `pulse-whatsapp-allow` allows tcp:3000 |
| App slow / hung | Use `e2-medium` or larger, not `e2-small` |
| WhatsApp logout after migrate | Re-scan QR on Connect page |
| Wrong GCP account | `gcloud auth login` with correct Gmail |

## Static IP (recommended)

```powershell
gcloud compute addresses create pulse-whatsapp-ip --region=asia-south1
# Attach to VM via Console: VPC → IP addresses → Reserve / assign
```
