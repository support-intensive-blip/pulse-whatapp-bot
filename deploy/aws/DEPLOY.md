# AWS Deployment Guide — Pulse WhatsApp AI

Deploy Pulse on **Amazon EC2** with Docker. Same architecture as GCP: always-on VM + Chromium + SQLite + React dashboard.

**Do not use** Lambda, App Runner, or Fargate for the full bot — WhatsApp Web needs a persistent browser session.

---

## Architecture

```
EC2 (t3.medium, Ubuntu 22.04)
├── Docker Compose
├── whatsapp-web.js + Chromium
├── SQLite (EBS volume)
├── Team knowledge bases
├── React dashboard (built in image)
└── OpenAI API (per-team keys in DB)
```

---

## Prerequisites

1. **AWS account** with billing enabled
2. **AWS CLI** installed and configured:
   ```bash
   aws configure
   ```
3. **EC2 key pair** (.pem file) in your target region
   - AWS Console → EC2 → Key Pairs → Create
4. **OpenAI API key** (or per-team keys via dashboard after deploy)
5. **SSH client** (OpenSSH on Windows 10+, or WSL)

---

## Quick deploy (Windows)

From the project root:

```powershell
powershell -ExecutionPolicy Bypass -File "deploy\aws\deploy.ps1" `
  -Region ap-south-1 `
  -KeyName your-ec2-key-name `
  -KeyPath "C:\path\to\your-key.pem"
```

**First run** creates:
- Security group `pulse-whatsapp-sg` (ports 22, 3000)
- EC2 instance `pulse-whatsapp-vm` (t3.medium, 30 GB)

**Later runs** reuse the same instance and redeploy code.

### Deploy to existing instance

```powershell
powershell -ExecutionPolicy Bypass -File "deploy\aws\deploy.ps1" `
  -Region ap-south-1 `
  -InstanceId i-0123456789abcdef0 `
  -KeyPath "C:\path\to\your-key.pem"
```

---

## Quick deploy (Linux / macOS / WSL)

```bash
chmod +x deploy/aws/deploy.sh
./deploy/aws/deploy.sh \
  --region ap-south-1 \
  --key-name your-ec2-key-name \
  --key-path ~/.ssh/your-key.pem
```

---

## After first deploy — configure `.env`

SSH into the server:

```bash
ssh -i your-key.pem ubuntu@<PUBLIC_IP>
sudo nano /opt/whatsapp-ai-assistant/.env
```

Set at minimum:

```env
OPENAI_API_KEY=sk-...
JWT_SECRET=long-random-secret
DASHBOARD_ADMIN_EMAIL=admin@yourdomain.com
DASHBOARD_ADMIN_PASSWORD=strong-password
ASSISTANT_NAME=JahNavi
KNOWLEDGE_BASE_PATH=knowledge-base/nxtwave-intensive-knowledge-base.pdf
WHATSAPP_TAKEOVER_ON_CONFLICT=true
```

Restart:

```bash
cd /opt/whatsapp-ai-assistant
sudo docker compose restart
```

Open **http://&lt;PUBLIC_IP&gt;:3000** → login → **Connect** → scan WhatsApp QR.

---

## Upload knowledge base PDF

From your machine:

```bash
scp -i your-key.pem knowledge-base/nxtwave-intensive-knowledge-base.pdf \
  ubuntu@<PUBLIC_IP>:/opt/whatsapp-ai-assistant/knowledge-base/
```

Then re-ingest from the dashboard (**Configuration → Models & KB**).

---

## Elastic IP (recommended for production)

EC2 public IPs change on stop/start. Assign a static Elastic IP:

```bash
aws ec2 allocate-address --region ap-south-1 --domain vpc
aws ec2 associate-address --region ap-south-1 --instance-id i-xxx --allocation-id eipalloc-xxx
```

---

## Security hardening (recommended)

| Item | Action |
|------|--------|
| SSH | Restrict port 22 to your IP in the security group |
| Dashboard | Put nginx + HTTPS in front, or use ALB + ACM certificate |
| Secrets | Never commit `.env`; use team API keys in dashboard |
| Admin password | Change default `admin123` immediately |

---

## Operations

```bash
cd /opt/whatsapp-ai-assistant
sudo docker compose logs -f
sudo docker compose restart
```

Redeploy from your machine:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\aws\deploy.ps1 -KeyPath ... -InstanceId i-xxx
```

---

## Cost estimate (ap-south-1)

| Resource | ~Monthly |
|----------|----------|
| t3.medium (on-demand) | $30–35 USD |
| 30 GB gp3 EBS | $3 USD |
| OpenAI API | Usage-based |

---

## GCP vs AWS

| | GCP (current) | AWS |
|--|---------------|-----|
| Script | `deploy\gcp\deploy.ps1` | `deploy\aws\deploy.ps1` |
| VM | e2-medium | t3.medium |
| Region | asia-south1-a | ap-south-1 (Mumbai) |

You can run both independently; data is not synced between clouds.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| SSH timeout | Check security group port 22; wait 2–3 min after launch |
| Port 3000 blocked | Open TCP 3000 in `pulse-whatsapp-sg` |
| WhatsApp offline | Dashboard → Connect → scan QR |
| Chromium OOM | Upgrade to t3.large |
