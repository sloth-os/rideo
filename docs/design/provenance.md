# Provenance: Content Credentials, disclosure and consent

Rideo makes it verifiable that its output is AI-generated, by whom, and from what. Every generated take and
every export carries four layers of provenance:

| Layer | What it holds | Survives | Read by |
|---|---|---|---|
| **C2PA Content Credentials** | a signed manifest embedded in the MP4: "AI-generated" (IPTC digital source type), the generator and model, the actions, the ingredients (an export lists its takes, each with its own manifest), the watermark id as a soft binding | copying and serving the file unchanged; removed by re-encoding or stripping | any C2PA validator (Adobe Content Authenticity, `c2patool`, the Rideo Verify page) |
| **Invisible keyed watermark** | the 48-bit watermark id in the luma DCT domain ([watermark](watermark.md)) | re-encoding, trimming, rescaling, metadata stripping | Rideo detection (`/api/watermark/detect`, Verify page, MCP) |
| Container metadata | `comment=rideo-wm:v1:<id>`, copyright, description | remux only | any media tool |
| Provenance registry | `watermarks/<id>.json`: brand, owner, project, asset, media hash | – | Rideo detection |

C2PA is the open standard the industry uses (Adobe, Runway, OpenAI, Google, Frame.io). The watermark is the
fallback when a platform strips the manifest; the manifest's **soft binding** names the watermark id, so a
validator that finds either one can link back to the other.

## Why: EU AI Act Article 50

From 2 August 2026, providers of AI systems that generate synthetic audio, images or video must mark the
output in a machine-readable format so it is detectable as artificially generated, and offer a free way to
detect it; deployers that publish **deepfakes** (content resembling real people) must disclose that it is
artificial. Systems placed on the market before that date must comply by 2 December 2026. Rideo covers:

| Obligation | How |
|---|---|
| Machine-readable marking of outputs (Art. 50(2)) | C2PA manifest with an AI digital source type on every take and export, plus the invisible watermark |
| Detectability / free detection tool | the public `POST /api/watermark/detect` and the Verify page work without an account |
| Deepfake disclosure (Art. 50(4)) | the visible disclosure label is forced onto exports that contain a real-person character (below) |
| Lawful use of real people's likeness and voice | consent records on every uploaded reference that depicts a real person, and on voice clones |

## Manifests

Manifests are built with the official C2PA SDK (`@contentauth/c2pa-node`, the Rust `c2pa-rs` core) in the
server's `provenance/c2pa.ts` and signed with ES256. Rideo's own assertions use the `org.rideo.` prefix.

### Takes

Signed in the shot pipeline right after the watermark is embedded, before the take is stored.

| Part | Content |
|---|---|
| intent | `create` with digital source type `http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia` |
| `c2pa.actions.v2` | `c2pa.created` (software agent: the video model mm-gateway reported, parameters `{imageModel, videoModel, gateway: "mm-gateway"}`), then `c2pa.watermarked` when the watermark is on |
| `c2pa.soft-binding` | `{alg: "org.rideo.watermark.1", blocks: [{scope: {}, value: base64(watermark id)}]}` |
| `org.rideo.provenance` | `{project, asset: {kind: "take", clipId, shotId, takeId}, consistency: {status, score, judge}}` |
| ingredients | the verified keyframe the video started from (`inputTo`), when one was generated |

### Exports

Signed by `export.finish` after watermarking, encoding and muxing, before the export is published.

| Part | Content |
|---|---|
| digital source type | `compositeWithTrainedAlgorithmicMedia` when any ingredient is generated (takes, generated music), else `composite` (a footage edit) |
| `c2pa.actions.v2` | `c2pa.created`, one `c2pa.placed` listing the ingredient ids, `c2pa.watermarked` |
| ingredients | every distinct take on the timeline (`componentOf`, carrying the take's own manifest, so a validator walks back to each generation) and every uploaded or generated resource (footage, music; their manifests are kept when they have one) |
| `c2pa.soft-binding` | the export's watermark id |
| `org.rideo.provenance` | `{project, asset: {kind: "export", exportId}, timelineCommit}` |
| `org.rideo.disclosure` | `{label: boolean, text, reason: "policy" \| "real_person" \| null}` |

Manifests never contain names of real people, consent details or prompts: they travel with the file to
the public.

### Signing credentials

| Setting | Meaning |
|---|---|
| `RIDEO_C2PA_CERT` | PEM certificate chain (leaf first), a file path or the PEM text. The leaf needs `digitalSignature` and an EKU C2PA accepts (for example `emailProtection` or the C2PA claim-signing EKU). |
| `RIDEO_C2PA_KEY` | PEM private key of the leaf (PKCS#8 or SEC1), a file path or the PEM text |
| `RIDEO_C2PA_TSA_URL` | optional RFC 3161 time-stamp authority; a timestamp keeps the signature valid after the certificate expires |
| `RIDEO_C2PA` | `on` (default) or `off` |

Without a certificate, Rideo creates a **development signer** on first start: a P-256 CA and a leaf
certificate written to `RIDEO_DATA_DIR/c2pa/` (`ca.pem`, `cert.pem`, `key.pem` with mode `0600`), and logs a
warning. Validators show its signatures as valid but untrusted; add `ca.pem` to a validator's trust list
to trust it locally. Production deployments use a certificate from a CA on the C2PA trust list.

Signing fails closed: when C2PA is on and signing fails, the shot step or the export fails (retryable)
instead of publishing an unsigned file. `RIDEO_C2PA=off` turns the layer off; the watermark stays.

## Verification

`POST /api/watermark/detect` runs both detectors on the uploaded file and returns:

```json
{
  "found": true, "id": "wm_3f2a9c01be77", "confidence": 0.94, "provenance": { "…": "registry record" },
  "contentCredentials": {
    "present": true, "state": "valid", "issues": [],
    "signer": {"commonName": "Rideo Studio", "issuer": "Rideo"}, "signedByThisStudio": true,
    "claimGenerator": "Rideo 0.1.0", "title": "export.mp4",
    "aiGenerated": true, "digitalSourceType": "…/compositeWithTrainedAlgorithmicMedia",
    "actions": ["c2pa.created", "c2pa.placed", "c2pa.watermarked"], "ingredients": 12,
    "watermarkId": "wm_3f2a9c01be77", "bound": true,
    "disclosure": {"label": true, "text": "AI-generated", "reason": "real_person"}
  }
}
```

- `state` is `invalid` (a hash or signature failed: the file was altered after signing), `valid`
  (intact, signer not on a trust list) or `trusted` (intact and the signer chains to a trust anchor in
  `RIDEO_C2PA_TRUST_ANCHORS`). `issues` lists the C2PA validation codes.
- `bound` is true when the manifest's soft binding names the watermark that was detected in the pixels.
- A file without a manifest returns `contentCredentials: {present: false}`.

### Public detection tool

The detection endpoint is the free detection tool Article 50 asks for, so it works **without the API token**
even when `RIDEO_API_TOKEN` is set:

| Caller | Accepted input | Response |
|---|---|---|
| public (no token) | multipart `file`, at most `RIDEO_PUBLIC_DETECT_MAX_BYTES` (default 512 MiB) | `found`, `id`, `confidence`, the brand (name, owner, URL), the asset kind and creation time, `contentCredentials` |
| authenticated | also `{uri}` and `{projectId, mediaPath}` | adds the full registry record (project id, asset ids, media path and hash) |

`{uri}` and `{projectId, mediaPath}` need the token because they make the server fetch media. The Verify
page (`/verify`) uses the public form and needs no sign-in.

## Disclosure label

A visible label (for example "AI-generated") in a corner of the picture, for the whole film:

```ts
settings.disclosure = {
  label: 'auto' | 'always' | 'off',          // default 'auto'
  text: string,                              // default 'AI-generated', ≤ 60 characters
  position: 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right',   // default 'top_right'
};
```

`disclosureFor(docs)` (shared) decides whether an export shows it:

| `label` | Timeline contains a real-person character | Label | `reason` |
|---|---|---|---|
| `always` | – | shown | `policy` |
| `auto` | yes | shown | `real_person` |
| `auto` | no | hidden | – |
| `off` | no | hidden | – |
| `off` | yes | **shown**: `off` cannot hide a deepfake | `real_person` |

`createExport` resolves the label and passes it to the `export.render` editor job. The shared render plan
draws it as a text item with the `label` style preset (small, boxed, in the chosen corner), so the ffmpeg.wasm
and WebCodecs engines render it identically. The export records `disclosure` and its manifest carries
`org.rideo.disclosure`. The editor preview shows the same label.

## Consent records

Uploaded references of characters may show real people. Every uploaded reference carries a consent record:

```ts
type Consent = {
  depictsRealPerson: boolean;
  subject?: string;        // who is shown (required when depictsRealPerson)
  grantedBy?: string;      // who consented: the person, or a legal guardian or rights holder (required)
  grantedAt?: string;      // ISO date of the consent (required)
  scope?: string;          // e.g. "this production, all territories, 5 years"
  evidence?: string;       // where the signed release is kept (a path or document id)
  recordedBy: Actor; recordedAt: string;
};
```

- Adding an uploaded reference requires `consent.depictsRealPerson` to be stated. When it is `true`, the
  subject, grantor and date are required, else the request fails with `consent_required` (422).
- A character whose approved references include one with `depictsRealPerson: true`, or whose voice is a clone
  of a real person, is a **real-person character**: the disclosure label is forced onto exports containing its
  takes, and the UI marks it.
- Cloning a voice from a recording needs a consent record like an uploaded likeness ([dialogue](dialogue.md));
  the TTS dialogue of takes is listed as an AI-generated ingredient of exports.
- Generated references never depict real people (the screenplay prompt forbids real people).
- Withdrawing consent means removing the reference; relocking the character marks its takes stale (R6), so
  they cannot be exported until regenerated.
- Consent records stay in the versioned character document (history shows who recorded them); they never
  enter C2PA manifests.

## Implementation map

| Piece | Module |
|---|---|
| Manifest building, signing, reading | `server/src/provenance/c2pa.ts` |
| Development certificate (DER builder on `node:crypto`) | `server/src/provenance/dev-cert.ts` |
| Disclosure rule, label injection into the render timeline | `shared/src/provenance/disclosure.ts` |
| Consent schema and validation | `shared/src/schemas/character.ts` (`ConsentSchema`) |
| Take signing | `server/src/jobs/handlers/shot.ts` (after the watermark) |
| Export signing | `server/src/jobs/handlers/media.ts` (`export.finish`) |
| Public detection | `server/src/http/routes.ts`, `server/src/http/app.ts` (auth exemption) |

Metrics: `rideo_c2pa_operations_total{op="sign"|"read", result}`. Logs carry `projectId`, `jobId` and the
manifest label (`urn:c2pa:…`).
