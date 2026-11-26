# Real SEV-SNP test data (public)

Used by `snp-checker.test.ts` to show the chip check accepts a genuine AMD report with AMD's real keys, not only
reports from the test-only chain in `snp-kit.ts`. Nothing here is ours or secret; nothing was fetched at test time.

| File | What | From |
|---|---|---|
| `milan-report.hex` | A real SEV-SNP attestation report (version 2, guest policy 0x30000, VMPL 0) from an AMD Milan chip, as hex | virtee/sev `tests/certs_data/report_milan.hex` (Apache-2.0), read 26 Nov 2026 |
| `milan-vcek.der` | That chip's VCEK, signed by AMD's SEV-Milan key | virtee/sev `tests/certs_data/vcek_milan.der` (Apache-2.0), read 26 Nov 2026 |
| `milan-crl-2026-11-24.der` | AMD's revocation list for Milan, issued 24 Nov 2026, next update 9 Jan 2027, CRL number 14, no entries | `https://kdsintf.amd.com/vcek/v1/Milan/crl`, fetched 26 Nov 2026 |

Checked before use: the VCEK verifies under the pinned ASK (`custodian/amd-roots.ts`), the report's signature verifies
under the VCEK, and the list verifies under the pinned ARK.

These are not the Servury host's. The first real report from the server (design test T2, TEST image, throwaway keys)
should be recorded and added here beside them.
