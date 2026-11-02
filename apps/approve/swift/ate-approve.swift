// ate-approve — Secure Enclave approval helper (SPEC §10.1).
//
// The approval key is created and used only by this binary. Its Secure Enclave dataRepresentation blob
// lives in a LOGIN-keychain generic-password item whose default (legacy) ACL trusts only the creating
// binary. The Touch ID prompt text is built solely from the decoded payload; callers cannot supply it.
//
// Mirrors apps/approve/src/payload.ts exactly (validation + renderReason). Build: scripts/build-swift.sh.
//
// Commands (one JSON line on stdout):
//   status | pubkey | reason <b64url> | sign <b64url|->
// Exit codes: 0 ok, 1 internal, 2 invalid_payload/expired, 3 unavailable/no_key, 4 denied, 5 keychain, 64 usage.

import CryptoKit
import Foundation
import LocalAuthentication
import Security

let KEYCHAIN_SERVICE = "dev.vikings.ate.approve"
let KEYCHAIN_ACCOUNT = "approval-key-v1"
let DEGRADE_MSG = "Secure Enclave unavailable on this machine; use the §10.1 armed TTY one-time-code fallback (approval-fallback enable on the daemon TTY)"

// MARK: - output

func jsonLine(_ obj: [String: Any]) -> String {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes])
    return String(data: data, encoding: .utf8)!
}

func finish(_ obj: [String: Any], code: Int32 = 0) -> Never {
    FileHandle.standardOutput.write((jsonLine(obj) + "\n").data(using: .utf8)!)
    exit(code)
}

func fail(_ error: String, _ message: String, _ code: Int32) -> Never {
    finish(["ok": false, "error": error, "message": message], code: code)
}

struct PayloadError: Error {
    let code: String  // invalid_payload | expired
    let message: String
}

func req(_ cond: Bool, _ msg: String) throws {
    if !cond { throw PayloadError(code: "invalid_payload", message: msg) }
}

// MARK: - JSON value helpers (JS semantics)

func isBool(_ v: Any?) -> Bool {
    guard let n = v as? NSNumber else { return false }
    return CFGetTypeID(n) == CFBooleanGetTypeID()
}

func isNumber(_ v: Any?) -> Bool {
    guard let n = v as? NSNumber else { return false }
    return CFGetTypeID(n) != CFBooleanGetTypeID()
}

/// JS: typeof x === "number" && Number.isSafeInteger(x) && x >= 0
func asInt(_ v: Any?) -> Int64? {
    guard isNumber(v), let n = v as? NSNumber else { return nil }
    let d = n.doubleValue
    guard d.isFinite, d == d.rounded(), abs(d) <= 9007199254740991, d >= 0 else { return nil }
    return Int64(d)
}

/// JS: typeof x === "string" && x.length > 0 && x.length <= max (UTF-16 length)
func isStr(_ v: Any?, _ max: Int = 256) -> Bool {
    guard let s = v as? String else { return false }
    let n = s.utf16.count
    return n > 0 && n <= max
}

func matches(_ v: Any?, _ pattern: String) -> Bool {
    guard let s = v as? String else { return false }
    return s.range(of: pattern, options: .regularExpression) != nil
}

let HEX_ADDR = "^0x[0-9a-fA-F]{40}$"
let HEX_32 = "^0x[0-9a-fA-F]{64}$"
let UINT = "^[0-9]+$"
let DEC = "^[0-9]+(\\.[0-9]+)?$"

func jsNumber(_ n: NSNumber) -> String {
    let d = n.doubleValue
    if d.isFinite && d == d.rounded() && abs(d) < 1e21 {
        if abs(d) <= 9.2e18 { return String(Int64(d)) }
        return String(format: "%.0f", d)
    }
    return "\(d)"
}

func jsString(_ s: String) -> String {
    var out = "\""
    for u in s.unicodeScalars {
        switch u {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\u{08}": out += "\\b"
        case "\u{0C}": out += "\\f"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if u.value < 0x20 {
                out += String(format: "\\u%04x", u.value)
            } else {
                out.unicodeScalars.append(u)
            }
        }
    }
    return out + "\""
}

/// Mirror of TS canonicalJson (sorted keys by UTF-16 order, no whitespace, nulls kept).
func canonicalJson(_ v: Any?) -> String {
    guard let v = v, !(v is NSNull) else { return "null" }
    if isBool(v) { return (v as! NSNumber).boolValue ? "true" : "false" }
    if let n = v as? NSNumber { return jsNumber(n) }
    if let s = v as? String { return jsString(s) }
    if let a = v as? [Any] { return "[" + a.map { canonicalJson($0) }.joined(separator: ",") + "]" }
    if let o = v as? [String: Any] {
        let keys = o.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
        return "{" + keys.map { jsString($0) + ":" + canonicalJson(o[$0]) }.joined(separator: ",") + "}"
    }
    return "null"
}

func renderValue(_ v: Any?) -> String {
    guard let v = v, !(v is NSNull) else { return "none" }
    if let s = v as? String { return s }
    if isBool(v) { return (v as! NSNumber).boolValue ? "true" : "false" }
    if let n = v as? NSNumber { return jsNumber(n) }
    return canonicalJson(v)
}

func formatUnits(_ raw: String, _ decimals: Int) -> String {
    var s = Substring(raw)
    while s.count > 1 && s.first == "0" { s = s.dropFirst() }
    let str = String(s)
    if decimals == 0 { return str }
    let padded = str.count < decimals + 1 ? String(repeating: "0", count: decimals + 1 - str.count) + str : str
    let intPart = String(padded.prefix(padded.count - decimals))
    var frac = String(padded.suffix(decimals))
    while frac.last == "0" { frac.removeLast() }
    return frac.isEmpty ? intPart : "\(intPart).\(frac)"
}

func short(_ hex: String) -> String {
    let u = Array(hex.utf16)
    if u.count > 14 {
        return String(utf16CodeUnits: Array(u.prefix(8)), count: 8) + "…" + String(utf16CodeUnits: Array(u.suffix(6)), count: 6)
    }
    return hex
}

// MARK: - validation (mirror of validatePayload)

let KINDS = ["payment", "trade", "chat_session", "ui_attach", "strategy", "config"]

func onlyKeys(_ o: [String: Any], _ allowed: [String], _ whereStr: String) throws {
    for k in o.keys { try req(allowed.contains(k), "\(whereStr): unexpected field \(k)") }
}

func validate(_ x: Any) throws -> [String: Any] {
    guard let p = x as? [String: Any] else { throw PayloadError(code: "invalid_payload", message: "payload must be an object") }
    try onlyKeys(p, ["v", "kind", "aud", "nonce", "issuedAt", "expiresAt", "body"], "payload")
    try req(asInt(p["v"]) == 1 && isNumber(p["v"]), "unsupported payload version")
    let kind = p["kind"] as? String ?? ""
    try req(KINDS.contains(kind), "unknown kind")
    let aud = p["aud"] as? String ?? ""
    try req(aud == "ate-daemon" || aud == "ate-pay", "bad aud")
    try req(isStr(p["nonce"], 128), "bad nonce")
    let issuedAt = asInt(p["issuedAt"]), expiresAt = asInt(p["expiresAt"])
    try req(issuedAt != nil && expiresAt != nil && expiresAt! > issuedAt!, "bad validity window")
    guard let b = p["body"] as? [String: Any] else { throw PayloadError(code: "invalid_payload", message: "bad body") }
    switch kind {
    case "payment":
        try req(aud == "ate-pay", "payment approvals are for ate-pay")
        try onlyKeys(b, ["stage", "paymentId", "paymentRequestId", "amountRaw", "decimals", "token", "tokenSymbol", "payTo", "payer", "chainId", "typedDataDigest", "validUntil", "feeRaw"], "payment")
        let stage = b["stage"] as? String
        try req(stage == "sign" || stage == "submit", "payment: bad stage")
        try req(isStr(b["paymentId"], 64) && isStr(b["paymentRequestId"], 128), "payment: bad ids")
        try req(matches(b["amountRaw"], UINT), "payment: bad amountRaw")
        try req((asInt(b["decimals"]).map { $0 <= 36 }) ?? false, "payment: bad decimals")
        try req(matches(b["token"], HEX_ADDR), "payment: bad token")
        try req(isStr(b["tokenSymbol"], 16), "payment: bad tokenSymbol")
        try req(matches(b["payTo"], HEX_ADDR), "payment: bad payTo")
        try req(matches(b["payer"], HEX_ADDR), "payment: bad payer")
        try req((asInt(b["chainId"]).map { $0 > 0 }) ?? false, "payment: bad chainId")
        try req(matches(b["typedDataDigest"], HEX_32), "payment: bad digest")
        try req(asInt(b["validUntil"]) != nil, "payment: bad validUntil")
        try req(b["feeRaw"] == nil || matches(b["feeRaw"], UINT), "payment: bad feeRaw")
    case "trade":
        try onlyKeys(b, ["proposalId", "market", "side", "amountUsd", "amountIn", "tokenIn"], "trade")
        try req(isStr(b["proposalId"], 80) && isStr(b["market"], 64), "trade: bad ids")
        let side = b["side"] as? String
        try req(side == "buy" || side == "sell", "trade: bad side")
        try req(matches(b["amountUsd"], DEC), "trade: bad amountUsd")
        try req(matches(b["amountIn"], UINT), "trade: bad amountIn")
        try req(matches(b["tokenIn"], HEX_ADDR), "trade: bad tokenIn")
    case "chat_session":
        try onlyKeys(b, ["sessionId"], "chat_session")
        try req(isStr(b["sessionId"], 80), "chat_session: bad sessionId")
    case "ui_attach":
        try onlyKeys(b, ["pid", "port"], "ui_attach")
        try req((asInt(b["pid"]).map { $0 > 0 }) ?? false, "ui_attach: bad pid")
        try req((asInt(b["port"]).map { $0 > 0 && $0 < 65536 }) ?? false, "ui_attach: bad port")
    case "strategy":
        try onlyKeys(b, ["changeId", "changes"], "strategy")
        try req(isStr(b["changeId"], 80), "strategy: bad changeId")
        guard let ch = b["changes"] as? [Any], ch.count > 0, ch.count <= 32 else { throw PayloadError(code: "invalid_payload", message: "strategy: bad changes") }
        for c in ch {
            guard let cc = c as? [String: Any] else { throw PayloadError(code: "invalid_payload", message: "strategy: bad change") }
            try onlyKeys(cc, ["scope", "field", "before", "after"], "strategy change")
            try req(isStr(cc["scope"], 64) && isStr(cc["field"], 64), "strategy: bad scope/field")
        }
    case "config":
        try onlyKeys(b, ["changes"], "config")
        guard let ch = b["changes"] as? [Any], ch.count > 0, ch.count <= 32 else { throw PayloadError(code: "invalid_payload", message: "config: bad changes") }
        for c in ch {
            guard let cc = c as? [String: Any] else { throw PayloadError(code: "invalid_payload", message: "config: bad change") }
            try onlyKeys(cc, ["key", "before", "after"], "config change")
            try req(isStr(cc["key"], 128), "config: bad key")
        }
    default:
        throw PayloadError(code: "invalid_payload", message: "unknown kind")
    }
    let now = Int64(Date().timeIntervalSince1970)
    if expiresAt! < now { throw PayloadError(code: "expired", message: "payload expired") }
    if issuedAt! > now + 60 { throw PayloadError(code: "expired", message: "payload issued in the future") }
    return p
}

// MARK: - reason (mirror of renderReason)

func renderReason(_ p: [String: Any]) -> String {
    let b = p["body"] as! [String: Any]
    func s(_ k: String) -> String { b[k] as? String ?? "" }
    func i(_ k: String) -> Int64 { asInt(b[k]) ?? 0 }
    switch p["kind"] as! String {
    case "payment":
        let dec = Int(i("decimals"))
        let step = s("stage") == "sign" ? "Sign payment authorization" : "Submit payment"
        let fee = b["feeRaw"] != nil ? " (fee \(formatUnits(s("feeRaw"), dec)))" : ""
        return "\(step): \(formatUnits(s("amountRaw"), dec)) \(s("tokenSymbol")) (\(short(s("token"))))\(fee) to \(s("payTo")) on chain \(i("chainId")), digest \(short(s("typedDataDigest")))"
    case "trade":
        return "Approve trade: \(s("side").uppercased()) $\(s("amountUsd")) on \(s("market")) (proposal \(short(s("proposalId"))))"
    case "chat_session":
        return "Open ATE chat session \(s("sessionId"))"
    case "ui_attach":
        return "Attach ATE desktop to daemon pid \(i("pid")) on port \(i("port"))"
    case "strategy":
        let ch = (b["changes"] as! [Any]).map { $0 as! [String: Any] }
        return "Loosen ATE strategy: " + ch.map { c in
            "\(c["scope"] as! String) \(c["field"] as! String) \(renderValue(c["before"])) → \(renderValue(c["after"]))"
        }.joined(separator: "; ")
    case "config":
        let ch = (b["changes"] as! [Any]).map { $0 as! [String: Any] }
        return "Change ATE config: " + ch.map { c in
            "\(c["key"] as! String) \(renderValue(c["before"])) → \(renderValue(c["after"]))"
        }.joined(separator: "; ")
    default:
        return ""
    }
}

// MARK: - decoding

func base64urlDecode(_ s: String) -> Data? {
    var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)
}

func loadPayload(_ arg: String) -> (Data, [String: Any]) {
    var input = arg
    if arg == "-" {
        let d = FileHandle.standardInput.readDataToEndOfFile()
        input = String(data: d, encoding: .utf8) ?? ""
    }
    guard let bytes = base64urlDecode(input), !bytes.isEmpty else { fail("invalid_payload", "payload is not base64url", 2) }
    guard let obj = try? JSONSerialization.jsonObject(with: bytes, options: []) else { fail("invalid_payload", "payload is not JSON", 2) }
    do {
        return (bytes, try validate(obj))
    } catch let e as PayloadError {
        fail(e.code, e.message, 2)
    } catch {
        fail("internal", "\(error)", 1)
    }
}

// MARK: - keychain

func readKeyBlob() -> Data? {
    let q: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: KEYCHAIN_SERVICE,
        kSecAttrAccount as String: KEYCHAIN_ACCOUNT,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    let st = SecItemCopyMatching(q as CFDictionary, &out)
    if st == errSecItemNotFound { return nil }
    if st != errSecSuccess { fail("keychain", "SecItemCopyMatching failed: \(st)", 5) }
    return out as? Data
}

func storeKeyBlob(_ blob: Data) {
    // Legacy login keychain (no kSecUseDataProtectionKeychain): default ACL trusts only this binary.
    let q: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: KEYCHAIN_SERVICE,
        kSecAttrAccount as String: KEYCHAIN_ACCOUNT,
        kSecAttrLabel as String: "ATE approval key (Secure Enclave blob)",
        kSecValueData as String: blob,
    ]
    let st = SecItemAdd(q as CFDictionary, nil)
    if st != errSecSuccess { fail("keychain", "SecItemAdd failed: \(st)", 5) }
}

func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
func keyId(_ pub: Data) -> String { String(hex(Data(SHA256.hash(data: pub))).prefix(16)) }

func biometricsAvailable() -> Bool {
    var err: NSError?
    return LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
}

// MARK: - commands

func cmdStatus() -> Never {
    let has = SecureEnclave.isAvailable ? (readKeyBlob() != nil) : false
    finish(["ok": true, "secureEnclave": SecureEnclave.isAvailable, "biometrics": biometricsAvailable(), "hasKey": has])
}

func cmdPubkey() -> Never {
    guard SecureEnclave.isAvailable else { fail("unavailable", DEGRADE_MSG, 3) }
    if let blob = readKeyBlob() {
        do {
            let k = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob)
            let pub = k.publicKey.x963Representation
            finish(["ok": true, "publicKey": hex(pub), "keyId": keyId(pub), "created": false])
        } catch {
            fail("internal", "stored key blob unusable: \(error)", 1)
        }
    }
    var cfErr: Unmanaged<CFError>?
    guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &cfErr) else {
        fail("internal", "SecAccessControlCreateWithFlags failed", 1)
    }
    do {
        let k = try SecureEnclave.P256.Signing.PrivateKey(compactRepresentable: false, accessControl: ac)
        storeKeyBlob(k.dataRepresentation)
        let pub = k.publicKey.x963Representation
        finish(["ok": true, "publicKey": hex(pub), "keyId": keyId(pub), "created": true])
    } catch {
        fail("unavailable", "Secure Enclave key creation failed: \(error). \(DEGRADE_MSG)", 3)
    }
}

func cmdReason(_ arg: String) -> Never {
    let (_, p) = loadPayload(arg)
    finish(["ok": true, "kind": p["kind"] as! String, "reason": renderReason(p)])
}

func cmdSign(_ arg: String) -> Never {
    let (bytes, p) = loadPayload(arg)
    let reason = renderReason(p)
    guard SecureEnclave.isAvailable else { fail("unavailable", DEGRADE_MSG, 3) }
    guard let blob = readKeyBlob() else { fail("no_key", "no approval key; run `ate-approve pubkey` at setup", 3) }

    let ctx = LAContext()
    let sem = DispatchSemaphore(value: 0)
    var authErr: Error?
    var okAuth = false
    ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
        okAuth = success
        authErr = error
        sem.signal()
    }
    sem.wait()
    if !okAuth {
        if let la = authErr as? LAError {
            switch la.code {
            case .userCancel, .authenticationFailed, .systemCancel, .appCancel, .userFallback:
                fail("denied", "authentication denied: \(la.localizedDescription)", 4)
            default:
                fail("unavailable", "authentication unavailable: \(la.localizedDescription)", 3)
            }
        }
        fail("denied", "authentication failed", 4)
    }
    do {
        let k = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
        let sig = try k.signature(for: bytes)
        let pub = k.publicKey.x963Representation
        finish(["ok": true, "signature": sig.derRepresentation.base64EncodedString(), "publicKey": hex(pub), "keyId": keyId(pub)])
    } catch {
        fail("internal", "signing failed: \(error)", 1)
    }
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage", "usage: ate-approve status|pubkey|reason <b64url>|sign <b64url|->", 64) }
switch args[1] {
case "status": cmdStatus()
case "pubkey": cmdPubkey()
case "reason":
    guard args.count >= 3 else { fail("usage", "reason needs a payload", 64) }
    cmdReason(args[2])
case "sign":
    guard args.count >= 3 else { fail("usage", "sign needs a payload (or -)", 64) }
    cmdSign(args[2])
default:
    fail("usage", "unknown command \(args[1])", 64)
}
