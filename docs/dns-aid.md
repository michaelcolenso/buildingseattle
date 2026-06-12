# DNS for AI Discovery (DNS-AID) — buildingseattle.com

DNS-AID (draft-mozleywilliams-dnsop-dnsaid) lets AI agents discover your
API endpoints through DNS. This document describes the records needed for
buildingseattle.com.

## Record placement

All DNS-AID records live under the `_agents` subdomain:

```
_a2a._agents.buildingseattle.com
_index._agents.buildingseattle.com
```

## DNS record template (Cloudflare DNS)

Add these records in the Cloudflare dashboard (DNS → Records) or via the
Cloudflare API:

### SVCB record for A2A protocol discovery

```
Type:   SVCB
Name:   _a2a._agents
TTL:    3600 (Auto)
Priority: 1
Target: buildingseattle.com
Parameters:
  alpn="h2"
  port=443
Service mode: 1 (alias mode — points directly to the origin)
```

### SVCB record for general agent index

```
Type:   SVCB
Name:   _index._agents
TTL:    3600 (Auto)
Priority: 1
Target: buildingseattle.com
Parameters:
  alpn="h2"
  port=443
```

The `mandatory` SvcParam can be added to require specific keys:

```
mandatory=alpn,port
```

## Cloudflare API (alternative)

```bash
# A2A discovery record
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "SVCB",
    "name": "_a2a._agents",
    "content": "1 buildingseattle.com alpn=\"h2\" port=443",
    "ttl": 3600
  }'

# General agent index record
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "SVCB",
    "name": "_index._agents",
    "content": "1 buildingseattle.com alpn=\"h2\" port=443",
    "ttl": 3600
  }'
```

## DNSSEC

Cloudflare provides DNSSEC automatically for domains on full setup. Verify
it's enabled in the Cloudflare dashboard under DNS → Settings → DNSSEC.

## Validation

After deploying the records, verify with:

```bash
dig _a2a._agents.buildingseattle.com SVCB +short
dig _index._agents.buildingseattle.com SVCB +short
```

Or scan via isitagentready.com:

```bash
curl -X POST https://isitagentready.com/api/scan \
  -H "Content-Type: application/json" \
  -d '{"url": "https://buildingseattle.com"}'
```

Check that `checks.discoverability.dnsAid.status` is `"pass"`.
