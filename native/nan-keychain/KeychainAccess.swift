import Foundation

enum KeychainTarget: Equatable {
  case session
  case chromeSafeStorage
}

enum KeychainReadResult: Equatable {
  case secret(String?)
  case interactionRequired
  case cancelled
  case denied
  case unavailable
}

enum KeychainMutationResult: Equatable {
  case success
  case notFound
  case interactionRequired
  case unavailable
}

enum BoundedInputError: Error {
  case tooLarge
}

protocol KeychainAccessing {
  func read(_ target: KeychainTarget, allowsAuthenticationUI: Bool) -> KeychainReadResult
  func updateSession(_ secret: Data, allowsAuthenticationUI: Bool) -> KeychainMutationResult
  func addSession(_ secret: Data, allowsAuthenticationUI: Bool) -> KeychainMutationResult
  func deleteSession(allowsAuthenticationUI: Bool) -> KeychainMutationResult
}

func readSession(using keychain: KeychainAccessing) -> KeychainReadResult {
  keychain.read(.session, allowsAuthenticationUI: false)
}

func readChromeSafeStorage(using keychain: KeychainAccessing) -> KeychainReadResult {
  let firstAttempt = keychain.read(.chromeSafeStorage, allowsAuthenticationUI: false)
  guard firstAttempt == .interactionRequired else { return firstAttempt }
  return keychain.read(.chromeSafeStorage, allowsAuthenticationUI: true)
}

func putSession(_ secret: Data, using keychain: KeychainAccessing) -> KeychainMutationResult {
  switch keychain.updateSession(secret, allowsAuthenticationUI: false) {
  case .success: return .success
  case .notFound:
    return keychain.addSession(secret, allowsAuthenticationUI: false) == .success ? .success : .unavailable
  case .interactionRequired, .unavailable: return .unavailable
  }
}

func deleteSession(using keychain: KeychainAccessing) -> KeychainMutationResult {
  switch keychain.deleteSession(allowsAuthenticationUI: false) {
  case .success, .notFound: return .success
  case .interactionRequired, .unavailable: return .unavailable
  }
}

func collectBoundedInput(maximumBytes: Int, readChunk: () throws -> Data?) throws -> Data {
  var input = Data()
  while let chunk = try readChunk(), !chunk.isEmpty {
    input.append(chunk)
    if input.count > maximumBytes { throw BoundedInputError.tooLarge }
  }
  return input
}
