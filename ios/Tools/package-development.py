"""Verify an existing Apple development-signed app, then package a private IPA.

Never creates certificates, modifies provisioning profiles, or exports keys.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import plistlib
import re
import subprocess
import tempfile
import zipfile


def run(*args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace").strip()[:2000]
        raise SystemExit(f"{Path(args[0]).name} exited {result.returncode}: {detail}")
    return result.stdout


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def permits(pattern, value):
    return isinstance(pattern, str) and isinstance(value, str) and "*" not in value and (
        value == pattern or
        (pattern.endswith(".*") and pattern.count("*") == 1 and value.startswith(pattern[:-1]))
    )


def verify_staged_app(app, workspace, device_udid):
    # Require an Apple certificate chain, not an ad-hoc signature.
    run("codesign", "--verify", "--deep", "--strict", "-R=anchor apple generic", str(app))
    metadata = subprocess.run(
        ["codesign", "-d", "--verbose=4", str(app)], check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    description = (metadata.stdout + metadata.stderr).decode("utf-8", "replace")
    team_match = re.search(r"^TeamIdentifier=(\S+)$", description, re.M)
    require(team_match is not None and team_match.group(1) != "not set", "No signing team")
    require("Signature=adhoc" not in description, "Ad-hoc signature is not installable")
    require(re.search(r"^Authority=(?:Apple Development|iPhone Developer):", description, re.M),
            "Expected an Apple development certificate")
    team = team_match.group(1)
    with (app / "Info.plist").open("rb") as handle:
        info = plistlib.load(handle)
    bundle_id = info.get("CFBundleIdentifier")
    require(isinstance(bundle_id, str) and bundle_id, "Missing bundle identifier")
    profile_path = app / "embedded.mobileprovision"
    require(profile_path.is_file(), "Missing embedded provisioning profile")
    profile = plistlib.loads(run("security", "cms", "-D", "-i", str(profile_path)))
    entitlements = plistlib.loads(run("codesign", "-d", "--entitlements", ":-", str(app)))
    profile_entitlements = profile.get("Entitlements", {})
    signed_id = entitlements.get("application-identifier", "")
    authorized_id = profile_entitlements.get("application-identifier", "")
    require(isinstance(signed_id, str) and isinstance(authorized_id, str), "Invalid app identity")
    require(signed_id.endswith("." + bundle_id), "Signature does not match bundle identifier")
    require(permits(authorized_id, signed_id),
            "Provisioning profile does not authorize this app")
    require(team in profile.get("TeamIdentifier", []) and
            entitlements.get("com.apple.developer.team-identifier") == team and
            profile_entitlements.get("com.apple.developer.team-identifier") == team,
            "Signing team and provisioning team differ")
    require(entitlements.get("get-task-allow") is True and
            profile_entitlements.get("get-task-allow") is True,
            "Expected a development provisioning profile")
    expected_keys = {"application-identifier", "com.apple.developer.team-identifier",
                     "get-task-allow", "keychain-access-groups"}
    require(set(entitlements) <= expected_keys, "Unexpected signed entitlement; explicit review required")
    groups = entitlements.get("keychain-access-groups", [])
    permitted_groups = profile_entitlements.get("keychain-access-groups", [])
    require(isinstance(groups, list) and isinstance(permitted_groups, list), "Invalid keychain groups")
    require(all(group == signed_id and any(permits(pattern, group) for pattern in permitted_groups)
                for group in groups), "Keychain entitlement exceeds this app's authorization")
    devices = profile.get("ProvisionedDevices", [])
    require(isinstance(devices, list) and devices and not profile.get("ProvisionsAllDevices", False),
            "Expected an explicit development device list")
    if device_udid:
        require(device_udid in devices, "Selected device is not in this provisioning profile")
    expiry = profile.get("ExpirationDate")
    require(isinstance(expiry, datetime), "Profile expiration is missing")
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    require(expiry > datetime.now(timezone.utc), "Provisioning profile is expired")

    certificate_prefix = workspace / "signing-cert-"
    run("codesign", "-d", f"--extract-certificates={certificate_prefix}", str(app))
    leaf = workspace / "signing-cert-0"
    require(leaf.is_file(), "Signing leaf certificate could not be extracted")
    require(leaf.read_bytes() in profile.get("DeveloperCertificates", []),
            "Signing certificate is not authorized by the provisioning profile")
    dates = run("/usr/bin/openssl", "x509", "-inform", "DER", "-in", str(leaf),
                "-noout", "-startdate", "-enddate").decode("ascii")
    date_values = dict(line.split("=", 1) for line in dates.strip().splitlines())
    not_before = datetime.strptime(date_values["notBefore"], "%b %d %H:%M:%S %Y GMT").replace(tzinfo=timezone.utc)
    not_after = datetime.strptime(date_values["notAfter"], "%b %d %H:%M:%S %Y GMT").replace(tzinfo=timezone.utc)
    require(not_before <= datetime.now(timezone.utc) < not_after, "Signing certificate is not currently valid")
    return {
        "signatureVerified": True, "appleCertificateChain": True,
        "profileMatchesApplication": True, "developmentProfile": True,
        "certificateAuthorizedByProfile": True, "certificateCurrentlyValid": True,
        "entitlementsAuthorized": True, "authorizedDeviceCount": len(devices),
        "selectedDeviceVerified": bool(device_udid),
        "expiresAtUTC": min(expiry, not_after).isoformat(), "installed": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device-udid", help="Optional exact target UDID; never included in the report")
    args = parser.parse_args()
    app = args.app.resolve(strict=True)
    output = args.output.absolute()
    require(app.is_dir() and app.suffix == ".app", "Expected an existing .app directory")
    require(output.suffix == ".ipa" and not output.exists(), "IPA must be a new .ipa path")
    require(output.parent.is_dir(), "IPA parent directory must already exist")
    require(not output.is_relative_to(app), "IPA must be outside the signed app")

    with tempfile.TemporaryDirectory(prefix="agent-pocket-ipa-") as temporary:
        payload = Path(temporary) / "Payload"
        payload.mkdir()
        staged_app = payload / "AgentPocket.app"
        run("ditto", str(app), str(staged_app))
        report = verify_staged_app(staged_app, Path(temporary), args.device_udid)
        candidate = Path(temporary) / "AgentPocket.ipa"
        run("ditto", "-c", "-k", "--keepParent", str(payload), str(candidate))
        with zipfile.ZipFile(candidate) as archive:
            require("Payload/AgentPocket.app/Info.plist" in archive.namelist(), "Invalid IPA structure")
        # Exclusive creation keeps an existing artifact intact even if another process races us.
        with output.open("xb") as target, candidate.open("rb") as source:
            while block := source.read(1024 * 1024):
                target.write(block)

    digest = hashlib.sha256()
    with output.open("rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    report.update({"sha256": digest.hexdigest(), "bytes": output.stat().st_size, "output": str(output)})
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
