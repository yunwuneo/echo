#!/usr/bin/env python3
"""Check extension install metadata in source plists or a built iOS app."""
import plistlib
import sys
from pathlib import Path


def check(app=None):
    root = Path(__file__).resolve().parents[1] / "apps/apple"
    parent_path = app / "Info.plist" if app else root / "iOS/Info.plist"
    with parent_path.open("rb") as stream:
        parent = plistlib.load(stream)
    for name, folder, point in (
        ("EchoShare", "ShareExtension", "com.apple.share-services"),
        ("EchoWidgets", "Widgets", "com.apple.widgetkit-extension"),
    ):
        path = app / "PlugIns" / f"{name}.appex/Info.plist" if app else root / folder / "Info.plist"
        with path.open("rb") as stream:
            info = plistlib.load(stream)
        extension = info.get("NSExtension", {})
        assert extension.get("NSExtensionPointIdentifier") == point, f"{name}: missing/wrong extension point"
        for key in ("CFBundleExecutable", "CFBundleIdentifier", "CFBundleName", "CFBundleDisplayName"):
            assert isinstance(info.get(key), str) and info[key], f"{name}: missing {key}"
            if app:
                assert "$(" not in info[key], f"{name}: unresolved {key}"
        for key in ("CFBundleShortVersionString", "CFBundleVersion"):
            assert info.get(key) and info[key] == parent.get(key), f"{name}: {key} differs from app"
        assert info.get("CFBundlePackageType") == "XPC!", f"{name}: wrong package type"
        if app:
            assert info["CFBundleIdentifier"].startswith(parent["CFBundleIdentifier"] + "."), f"{name}: wrong parent ID"
            assert (path.parent / info["CFBundleExecutable"]).is_file(), f"{name}: missing executable"
        if name == "EchoShare":
            principal = extension.get("NSExtensionPrincipalClass", "")
            assert principal.endswith(".ShareViewController"), "Share controller not registered"
            if app:
                assert "$(" not in principal, "Unresolved share controller module"
            rule = extension.get("NSExtensionAttributes", {}).get("NSExtensionActivationRule", {})
            assert isinstance(rule, dict), "Share activation must use supported types"
            assert rule.get("NSExtensionActivationSupportsText") is True, "Text sharing missing"
            assert rule.get("NSExtensionActivationSupportsImageWithMaxCount") == 1, "Image sharing missing"
    print("Apple bundle metadata passed" + (f": {app}" if app else " (source plists)"))


if __name__ == "__main__":
    check(Path(sys.argv[1]) if len(sys.argv) > 1 else None)
