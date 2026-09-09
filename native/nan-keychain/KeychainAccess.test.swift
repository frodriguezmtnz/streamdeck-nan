import Foundation

final class MockKeychain: KeychainAccessing {
  var readResults: [KeychainReadResult]
  var mutationResults: [KeychainMutationResult]
  var readQueries: [(KeychainTarget, Bool)] = []
  var mutationQueries: [(String, Bool)] = []

  init(readResults: [KeychainReadResult] = [], mutationResults: [KeychainMutationResult] = []) {
    self.readResults = readResults
    self.mutationResults = mutationResults
  }

  func read(_ target: KeychainTarget, allowsAuthenticationUI: Bool) -> KeychainReadResult {
    readQueries.append((target, allowsAuthenticationUI))
    return readResults.removeFirst()
  }

  func updateSession(_ secret: Data, allowsAuthenticationUI: Bool) -> KeychainMutationResult {
    mutationQueries.append(("update", allowsAuthenticationUI))
    return mutationResults.removeFirst()
  }

  func addSession(_ secret: Data, allowsAuthenticationUI: Bool) -> KeychainMutationResult {
    mutationQueries.append(("add", allowsAuthenticationUI))
    return mutationResults.removeFirst()
  }

  func deleteSession(allowsAuthenticationUI: Bool) -> KeychainMutationResult {
    mutationQueries.append(("delete", allowsAuthenticationUI))
    return mutationResults.removeFirst()
  }
}

func require(_ condition: @autoclosure () -> Bool) {
  if !condition() { exit(1) }
}

@main
struct KeychainAccessTest {
  static func main() throws {
    let background = MockKeychain(readResults: [.interactionRequired])
    require(readSession(using: background) == .interactionRequired)
    require(background.readQueries.count == 1)
    require(background.readQueries[0].0 == .session && background.readQueries[0].1 == false)

    let importWithApproval = MockKeychain(readResults: [.interactionRequired, .secret("value")])
    require(readChromeSafeStorage(using: importWithApproval) == .secret("value"))
    require(importWithApproval.readQueries.count == 2)
    require(importWithApproval.readQueries[0].0 == .chromeSafeStorage && importWithApproval.readQueries[0].1 == false)
    require(importWithApproval.readQueries[1].0 == .chromeSafeStorage && importWithApproval.readQueries[1].1 == true)

    let cancelledImport = MockKeychain(readResults: [.interactionRequired, .cancelled])
    require(readChromeSafeStorage(using: cancelledImport) == .cancelled)
    require(cancelledImport.readQueries.count == 2)
    require(cancelledImport.readQueries[0].0 == .chromeSafeStorage && cancelledImport.readQueries[0].1 == false)
    require(cancelledImport.readQueries[1].0 == .chromeSafeStorage && cancelledImport.readQueries[1].1 == true)

    let deniedWithoutPrompt = MockKeychain(readResults: [.denied])
    require(readChromeSafeStorage(using: deniedWithoutPrompt) == .denied)
    require(deniedWithoutPrompt.readQueries.count == 1)
    require(deniedWithoutPrompt.readQueries[0].0 == .chromeSafeStorage && deniedWithoutPrompt.readQueries[0].1 == false)

    let promptRequiredForWrite = MockKeychain(mutationResults: [.interactionRequired])
    require(putSession(Data("secret".utf8), using: promptRequiredForWrite) == .unavailable)
    require(promptRequiredForWrite.mutationQueries.count == 1)
    require(promptRequiredForWrite.mutationQueries[0].0 == "update" && promptRequiredForWrite.mutationQueries[0].1 == false)

    let promptRequiredForDelete = MockKeychain(mutationResults: [.interactionRequired])
    require(deleteSession(using: promptRequiredForDelete) == .unavailable)
    require(promptRequiredForDelete.mutationQueries.count == 1)
    require(promptRequiredForDelete.mutationQueries[0].0 == "delete" && promptRequiredForDelete.mutationQueries[0].1 == false)

    var fragments = [Data("{\"operation\":\"get\"".utf8), Data("}\n".utf8)]
    let framedInput = try collectBoundedInput(maximumBytes: 64) { fragments.isEmpty ? nil : fragments.removeFirst() }
    require(String(data: framedInput, encoding: .utf8) == "{\"operation\":\"get\"}\n")

    var oversized = [Data(repeating: 0x61, count: 65)]
    do {
      _ = try collectBoundedInput(maximumBytes: 64) { oversized.isEmpty ? nil : oversized.removeFirst() }
      exit(1)
    } catch BoundedInputError.tooLarge {
    }
  }
}
