//! What a directory seed is made of, and whether one could be installed.
//!
//! A seed is three Tor documents in one JSON object — a microdesc consensus,
//! the authority certificates that check its signatures, and the
//! microdescriptors it names:
//!
//!   {"version":3,"consensus":"…","certificates":"…","microdescriptors":"…"}
//!
//! That is the shape the WASM client's `directorySeed` accepts, and this
//! module is the whole contract with it: the version, the field order (the
//! gateway recognises a seed by its first bytes), and the checks a seed has
//! to pass. The client trusts none of this; it revalidates the consensus
//! against its own pinned directory authorities before installing a relay.
//! What is checked here, with the same Arti document crates the client is
//! built on, is that the seed *could* be installed — signed by a strict
//! majority of the authorities the client pins, timely, with enough relays in
//! each role — so a hopeless seed fails here and not in every browser after a
//! forty-megabyte download.
//!
//! The caller does the fetching, from wherever it likes; what is here reads
//! the consensus for the paths to fetch next, checks the result, and encodes
//! it.

use anyhow::{anyhow, bail, Context};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::time::SystemTime;
use tor_checkable::{ExternallySigned, SelfSigned, TimeBound};
use tor_llcrypto::pk::rsa::RsaIdentity;
use tor_netdoc::doc::authcert::{AuthCert, AuthCertKeyIds};
use tor_netdoc::doc::microdesc::MicrodescReader;
use tor_netdoc::doc::netstatus::{MdConsensus, UnvalidatedMdConsensus};
use tor_netdoc::AllowAnnotations;
use tracing::warn;

/// The `version` the client's `directorySeed` accepts.
pub const SEED_VERSION: u32 = 3;

/// The consensus document a directory cache serves, compressed with zlib
/// when the `.z` suffix is added.
pub const CONSENSUS_PATH: &str = "/tor/status-vote/current/consensus-microdesc";

/// How many digests one `/tor/micro/d/` request may name. Each is one
/// 43-character path segment, so this keeps the URL within what a directory
/// cache accepts.
pub const MICRODESCRIPTORS_PER_REQUEST: usize = 90;

/// v3 identity fingerprints of the directory authorities, the set the client
/// pins (and the one Arti ships in `tor-dircommon`). The client ignores a
/// signature from anyone else and needs a strict majority of these.
const AUTHORITY_V3IDENTS: [&str; 9] = [
    "27102BC123E7AF1D4741AE047E160C91ADC76B21", // bastet
    "0232AF901C31A04EE9848595AF9BB7620D4C5B2E", // dannenberg
    "E8A9C45EDE6D711294FADF8E7951F4DE6CA56B58", // dizum
    "70849B868D606BAECFB6128C5E3D782029AA394F", // faravahar
    "ED03BB616EB2F60BEC80151114BB25CEF515B226", // gabelmoo
    "23D15D965BC35114467363C165C4F724B64B4F66", // longclaw
    "49015F787433103580E3B66A1707A00E60F2D15B", // maatuska
    "F533C81CEF0BC0267857C99B2F471ADF249FA232", // moria1
    "2F3DF9CA0E5D36F2685A2DA67184EB8DCB8CBA8C", // tor26
];

/// Floors for a usable directory, matching what the client refuses to
/// install: relays usable as a middle hop, and relays on the HSDir ring.
const MIN_MIDDLE_RELAYS: usize = 10;
const MIN_HSDIR_RELAYS: usize = 100;

/// The pinned authority identities, decoded.
fn trusted_authorities() -> Vec<RsaIdentity> {
    AUTHORITY_V3IDENTS
        .iter()
        .map(|hex| RsaIdentity::from_hex(hex).expect("authority fingerprint is not valid hex"))
        .collect()
}

/// A consensus that has been parsed but whose signatures are unchecked. It
/// says which certificates check it and nothing else: the relays inside are
/// reachable only through [`Self::verify`].
pub struct UnverifiedConsensus {
    body: String,
    unvalidated: UnvalidatedMdConsensus,
}

impl UnverifiedConsensus {
    /// Parse `body` as a microdesc consensus that is valid at `now`.
    pub fn parse(body: String, now: SystemTime) -> anyhow::Result<Self> {
        let (_, _, timebound) =
            MdConsensus::parse(&body).map_err(|error| anyhow!("not a consensus: {error}"))?;
        let unvalidated = timebound
            .if_valid_at(&now)
            .map_err(|error| anyhow!("the consensus is not timely: {error}"))?;
        Ok(Self { body, unvalidated })
    }

    /// The `/tor/keys/fp-sk/…` path that fetches the certificates this
    /// consensus needs, restricted to the pinned authorities. An error means
    /// no pinned authority signed it, which no certificate can repair.
    pub fn certificates_path(&self) -> anyhow::Result<String> {
        let trusted = trusted_authorities();
        let mut ids: Vec<AuthCertKeyIds> = self
            .unvalidated
            .signing_cert_ids()
            .filter(|ids| trusted.contains(&ids.id_fingerprint))
            .collect();
        if ids.is_empty() {
            bail!("the consensus carries no signature from a known directory authority");
        }
        ids.sort_unstable();
        let segments: Vec<String> = ids
            .iter()
            .map(|id| {
                format!(
                    "{}-{}",
                    hex::encode(id.id_fingerprint.as_bytes()),
                    hex::encode(id.sk_fingerprint.as_bytes())
                )
            })
            .collect();
        Ok(format!("/tor/keys/fp-sk/{}", segments.join("+")))
    }

    /// Check the signatures against `certificates` — the document the path
    /// from [`Self::certificates_path`] fetched — and open the consensus.
    pub fn verify(
        self,
        certificates: String,
        now: SystemTime,
    ) -> anyhow::Result<VerifiedConsensus> {
        let certs = parse_authority_certs(&certificates, now)?;
        let n_authorities = AUTHORITY_V3IDENTS.len();
        let consensus = self
            .unvalidated
            .set_n_authorities(n_authorities)
            .check_signature(&certs)
            .map_err(|error| {
                anyhow!(
                    "the consensus is not signed by {} of {n_authorities} directory authorities: {error}",
                    n_authorities / 2 + 1
                )
            })?;
        Ok(VerifiedConsensus {
            body: self.body,
            certificates,
            consensus,
        })
    }
}

/// Parse `body` as authority certificates, keeping only those that are
/// self-signed, timely at `now`, and issued by a pinned authority. A
/// certificate that fails any of those is dropped rather than fatal: the
/// consensus check that follows decides whether enough of them survived.
fn parse_authority_certs(body: &str, now: SystemTime) -> anyhow::Result<Vec<AuthCert>> {
    let trusted = trusted_authorities();
    let certs = AuthCert::parse_multiple(body)
        .map_err(|error| anyhow!("not authority certificates: {error}"))?;
    let mut kept = Vec::new();
    for cert in certs {
        let cert = match cert {
            Ok(cert) => cert,
            Err(error) => {
                warn!("Skipping an unparseable authority certificate: {error}");
                continue;
            }
        };
        let cert = match cert.check_signature() {
            Ok(cert) => cert,
            Err(error) => {
                warn!("Skipping an authority certificate with a bad signature: {error}");
                continue;
            }
        };
        let cert = match cert.if_valid_at(&now) {
            Ok(cert) => cert,
            Err(error) => {
                warn!("Skipping an authority certificate that is not timely: {error}");
                continue;
            }
        };
        if !trusted.contains(cert.id_fingerprint()) {
            warn!(
                "Skipping a certificate from unrecognised authority {}",
                hex::encode(cert.id_fingerprint().as_bytes())
            );
            continue;
        }
        kept.push(cert);
    }
    Ok(kept)
}

/// A consensus a strict majority of the pinned authorities signed, ready to
/// name the microdescriptors a seed should carry.
pub struct VerifiedConsensus {
    body: String,
    certificates: String,
    consensus: MdConsensus,
}

impl VerifiedConsensus {
    /// Every microdescriptor digest the consensus names, each once.
    ///
    /// The client, downloading through one bridge circuit, samples a few
    /// relays per role; a backend fetching from an authority can afford the
    /// whole network, which leaves path selection weighted across all of it.
    pub fn microdescriptor_digests(&self) -> Vec<[u8; 32]> {
        let mut seen = HashSet::new();
        self.consensus
            .relays()
            .iter()
            .map(|router| *router.md_digest())
            .filter(|digest| seen.insert(*digest))
            .collect()
    }

    /// The `/tor/micro/d/…` path that fetches `digests`. Ask for at most
    /// [`MICRODESCRIPTORS_PER_REQUEST`] at a time.
    pub fn microdescriptors_path(digests: &[[u8; 32]]) -> String {
        let segments: Vec<String> = digests
            .iter()
            .map(|digest| STANDARD_NO_PAD.encode(digest))
            .collect();
        format!("/tor/micro/d/{}", segments.join("-"))
    }

    /// Put the consensus, its certificates and `microdescriptors` — the
    /// concatenated bodies the paths from [`Self::microdescriptors_path`]
    /// fetched — through the floors the client applies to a directory, and
    /// encode what passes in the shape `directorySeed` accepts.
    pub fn into_seed(self, microdescriptors: String) -> anyhow::Result<BuiltSeed> {
        let counts = count_relays(&self.consensus, &microdescriptors)?;
        let lifetime = self.consensus.lifetime();
        let (valid_after, fresh_until, valid_until) = (
            lifetime.valid_after(),
            lifetime.fresh_until(),
            lifetime.valid_until(),
        );
        let encoded = encode_seed(&self.body, &self.certificates, &microdescriptors)?;
        Ok(BuiltSeed {
            encoded,
            relay_count: counts.relays,
            middle_count: counts.middle,
            hsdir_count: counts.hsdir,
            valid_after,
            fresh_until,
            valid_until,
        })
    }
}

/// The seed as the client reads it. Field order matters: the gateway
/// recognises a seed by its opening `{"version":`.
#[derive(Serialize)]
struct Seed<'a> {
    version: u32,
    consensus: &'a str,
    certificates: &'a str,
    microdescriptors: &'a str,
}

fn encode_seed(consensus: &str, certificates: &str, microdescriptors: &str) -> anyhow::Result<String> {
    serde_json::to_string(&Seed {
        version: SEED_VERSION,
        consensus,
        certificates,
        microdescriptors,
    })
    .context("encoding the seed")
}

struct RelayCounts {
    /// Relays with both a consensus entry and a microdescriptor.
    relays: usize,
    /// Of those, the ones usable as a middle hop.
    middle: usize,
    /// Of those, the ones on the HSDir ring.
    hsdir: usize,
}

/// Count the relays the client would end up with: those the consensus names
/// whose microdescriptor is in `microdescriptors`, by role, and refuse a
/// directory the client would refuse.
fn count_relays(consensus: &MdConsensus, microdescriptors: &str) -> anyhow::Result<RelayCounts> {
    let routers: HashMap<[u8; 32], _> = consensus
        .relays()
        .iter()
        .map(|router| (*router.md_digest(), router))
        .collect();

    let reader = MicrodescReader::new(microdescriptors, &AllowAnnotations::AnnotationsNotAllowed)
        .map_err(|error| anyhow!("not microdescriptors: {error}"))?;
    let mut seen = HashSet::new();
    let mut counts = RelayCounts {
        relays: 0,
        middle: 0,
        hsdir: 0,
    };
    for microdescriptor in reader {
        let microdescriptor = match microdescriptor {
            Ok(document) => document.into_microdesc(),
            Err(error) => {
                warn!("Skipping an unparseable microdescriptor: {error}");
                continue;
            }
        };
        if !seen.insert(*microdescriptor.digest()) {
            continue;
        }
        let Some(router) = routers.get(microdescriptor.digest()) else {
            continue;
        };
        counts.relays += 1;
        if router.is_flagged_fast() && router.is_flagged_stable() && router.is_flagged_v2dir() {
            counts.middle += 1;
        }
        if router.is_flagged_hsdir() {
            counts.hsdir += 1;
        }
    }

    if counts.middle < MIN_MIDDLE_RELAYS || counts.hsdir < MIN_HSDIR_RELAYS {
        bail!(
            "too few usable relays for a directory (middle: {}, HSDir: {})",
            counts.middle,
            counts.hsdir
        );
    }
    Ok(counts)
}

/// A seed the client will accept, and what it holds.
#[derive(Clone, Debug)]
pub struct BuiltSeed {
    /// The seed itself, as `directorySeed` takes it.
    pub encoded: String,
    /// Relays with both a consensus entry and a microdescriptor.
    pub relay_count: usize,
    /// Of those, the ones usable as a middle hop.
    pub middle_count: usize,
    /// Of those, the ones on the HSDir ring.
    pub hsdir_count: usize,
    /// When the consensus became valid.
    pub valid_after: SystemTime,
    /// When the authorities publish the next consensus. A seed built from
    /// this one is the newest available until then, and stale afterwards.
    pub fresh_until: SystemTime,
    /// When the consensus expires. The client refuses a seed past this.
    pub valid_until: SystemTime,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_fingerprints_decode() {
        assert_eq!(trusted_authorities().len(), AUTHORITY_V3IDENTS.len());
    }

    #[test]
    fn the_seed_opens_with_its_version_and_carries_the_documents() {
        let encoded = encode_seed("c\n", "k\n", "m\n").unwrap();
        assert!(encoded.starts_with(r#"{"version":3,"#), "{encoded}");
        let value: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(value["consensus"], "c\n");
        assert_eq!(value["certificates"], "k\n");
        assert_eq!(value["microdescriptors"], "m\n");
    }

    #[test]
    fn microdescriptor_paths_are_unpadded_base64_joined_by_dashes() {
        let path = VerifiedConsensus::microdescriptors_path(&[[0; 32], [255; 32]]);
        assert_eq!(
            path,
            "/tor/micro/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-\
             //////////////////////////////////////////8"
        );
    }

    #[test]
    fn a_consensus_that_is_not_a_consensus_is_rejected() {
        let error = UnverifiedConsensus::parse(
            "network-status-version 3\n".to_string(),
            SystemTime::UNIX_EPOCH,
        )
        .err()
        .expect("garbage is not a consensus");
        assert!(error.to_string().contains("consensus"), "{error}");
    }

    #[test]
    fn garbage_certificates_are_dropped() {
        let certs = parse_authority_certs("not a certificate\n", SystemTime::UNIX_EPOCH);
        assert!(certs.map(|certs| certs.is_empty()).unwrap_or(true));
    }
}
