import Foundation
import LocalAuthentication
import Security

private let maximumInputBytes = 8 * 1024
private let maximumSecretBytes = 4 * 1024
private let sessionService = "com.barbatdev.ai-usage.nan-session"
private let sessionAccount = "session-cache"
private let chromeService = "Chrome Safe Storage"
private let chromeAccount = "Chrome"

private enum Operation: String, Decodable {
  case put
  case get
  case delete
  case getChromeSafeStorage
}

private struct Request: Decodable {
  let operation: Operation
  let secret: String?
}

private final class SecurityKeychain: KeychainAccessing {
  func read(_ target: KeychainTarget, allowsAuthenticationUI: Bool) -> KeychainReadResult {
    var query = fixedQuery(for: target)
    let context = LAContext()
    context.interactionNotAllowed = !allowsAuthenticationUI
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecUseAuthenticationContext as String] = context
    query[kSecUseAuthenticationUI as String] = allowsAuthenticationUI ? kSecUseAuthenticationUIAllow : kSecUseAuthenticationUIFail

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return .secret(nil) }
    if status == errSecInteractionNotAllowed { return .interactionRequired }
    if status == errSecUserCanceled { return .cancelled }
    if status == errSecAuthFailed { return .denied }
    guard status == errSecSuccess, let data = result as? Data, data.count <= maximumSecretBytes,
          let secret = String(data: data, encoding: .utf8) else { return .unavailable }
    return .secret(secret)
  }

  func updateSession(_ secret: Data, allowsAuthenticationUI: Bool) -> KeychainMutationResult {
    guard !allowsAuthenticationUI else { return .unavailable }
    let attributes: [String: Any] = [kSecValueData as String: secret]
    return mutationResult(SecItemUpdate(mutationQuery() as CFDictionary, attributes as CFDictionary))
  }

  func addSession(_ secret: Data, allowsAuthenticationUI: Bool) -> KeychainMutationResult {
    guard !allowsAuthenticationUI else { return .unavailable }
    var item = mutationQuery()
    item[kSecValueData as String] = secret
    return mutationResult(SecItemAdd(item as CFDictionary, nil))
  }

  func deleteSession(allowsAuthenticationUI: Bool) -> KeychainMutationResult {
    guard !allowsAuthenticationUI else { return .unavailable }
    return mutationResult(SecItemDelete(mutationQuery() as CFDictionary))
  }

  private func fixedQuery(for target: KeychainTarget) -> [String: Any] {
    let identity: (String, String) = switch target {
    case .session: (sessionService, sessionAccount)
    case .chromeSafeStorage: (chromeService, chromeAccount)
    }
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: identity.0,
      kSecAttrAccount as String: identity.1,
    ]
  }

  private func mutationQuery() -> [String: Any] {
    var query = fixedQuery(for: .session)
    let context = LAContext()
    context.interactionNotAllowed = true
    query[kSecUseAuthenticationContext as String] = context
    query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
    return query
  }

  private func mutationResult(_ status: OSStatus) -> KeychainMutationResult {
    if status == errSecSuccess { return .success }
    if status == errSecItemNotFound { return .notFound }
    if status == errSecInteractionNotAllowed { return .interactionRequired }
    return .unavailable
  }
}

private func writeResponse(_ value: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else {
    FileHandle.standardOutput.write(Data("{\"ok\":false,\"error\":\"unavailable\"}\n".utf8))
    return
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

private func fail() -> Never {
  writeResponse(["ok": false, "error": "unavailable"])
  exit(1)
}

private func writeSecretResponse(_ result: KeychainReadResult) {
  guard case let .secret(secret) = result else { fail() }
  writeResponse(["ok": true, "secret": secret ?? NSNull()])
}

private func putSessionSecret(_ secret: String, keychain: KeychainAccessing) {
  guard !secret.isEmpty, secret.lengthOfBytes(using: .utf8) <= maximumSecretBytes,
        putSession(Data(secret.utf8), using: keychain) == .success else { fail() }
  writeResponse(["ok": true])
}

private func readStandardInput() throws -> Data {
  try collectBoundedInput(maximumBytes: maximumInputBytes) {
    try FileHandle.standardInput.read(upToCount: 1024)
  }
}

@main
private struct NanKeychain {
  static func main() {
    let keychain = SecurityKeychain()
    do {
      let input = try readStandardInput()
      guard input.last == 0x0a, let request = try? JSONDecoder().decode(Request.self, from: input) else { fail() }
      switch request.operation {
      case .put:
        guard let secret = request.secret else { fail() }
        putSessionSecret(secret, keychain: keychain)
      case .delete:
        guard request.secret == nil, deleteSession(using: keychain) == .success else { fail() }
        writeResponse(["ok": true])
      case .get:
        guard request.secret == nil else { fail() }
        writeSecretResponse(readSession(using: keychain))
      case .getChromeSafeStorage:
        guard request.secret == nil else { fail() }
        writeSecretResponse(readChromeSafeStorage(using: keychain))
      }
    } catch {
      fail()
    }
  }
}
