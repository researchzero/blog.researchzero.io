---
title: "Try/Catch Is Not a General Failure Boundary in Solidity"
description: "Solidity try/catch is narrower than general exception handling: it catches specific high-level external call failures, but not malformed success returndata or every failure around the call expression."
date: 2026-05-20
author: "ResearchZero"
tags: ["solidity", "security", "auditing", "evm"]
---

`try/catch` is one of those Solidity features that feels familiar enough to be dangerous. It borrows the shape of exception handling, but its boundary is much narrower than most developers expect.

Solidity's `try/catch` looks like a familiar exception boundary, but the actual construct is narrower and more surprising. It is not "catch everything that goes wrong while calling this target". It is a compiler-lowered dispatch around a small set of expression kinds, with ABI decoding and catch-clause selection happening in very specific places.

The first important rule is syntactic: `try` only accepts high-level external function calls, contract creation, and high-level library delegate calls. Raw low-level calls are rejected even though they are external EVM operations.

```solidity
try other.f() returns (uint256 x) {
    ...
} catch {
    ...
}

try new Child() returns (Child c) {
    ...
} catch {
    ...
}

try target.call(data) returns (bool ok, bytes memory ret) {
    ...
} catch {
    ...
}
// compile error 2536
```

The low-level call case is one of the easiest traps. `address.call`, `address.staticcall`, and `address.delegatecall` are all external EVM calls, but the compiler classifies them as `BareCall`, `BareStaticCall`, and `BareDelegateCall`. The try allowlist accepts `External`, `Creation`, and high-level library `DelegateCall`, not the bare variants. That means a refactor from `iface.f()` to `address(iface).call(...)` silently invalidates every surrounding `try`.

The second rule is semantic: a successful call can still bypass the `catch`. If the CALL returns success but the returned bytes cannot be decoded as the return type declared by the caller, the ABI decoder reverts before the generated try/catch switch runs. The catch clauses never see it.

```solidity
interface IFace {
    function f() external returns (uint256);
}

contract ShortReturner {
    fallback() external {
        assembly { return(0, 0) }
    }
}

contract Caller {
    function probe(address t) external returns (uint256) {
        try IFace(t).f() returns (uint256 x) {
            return x;
        } catch {
            return 999;
        }
    }
}
```

Calling `probe(address(new ShortReturner()))` reverts. It does not return `999`. The callee did not revert. It returned successfully with zero bytes. The caller then tried to decode those zero bytes as a `uint256`, and that decode failure happened before the try/catch dispatch point.

This generalizes beyond EOAs. Any target that returns too-short static data, malformed dynamic data, or bad offsets can force the caller to revert through the very `try/catch` that was meant to tolerate failure.

Catch clause dispatch has its own shape. Source order is not first-match order. `catch Error(string)`, `catch Panic(uint256)`, and `catch (bytes memory)` are stored as named clause types in the AST, and codegen prioritizes Error and Panic selectors over the fallback bytes clause regardless of how the clauses were written.

```solidity
try t.fail() {
    return 1;
} catch (bytes memory) {
    return 2;
} catch Error(string memory) {
    return 3;
}
```

If `t.fail()` reverts with `Error("...")`, this returns `3`, not `2`. Putting `catch (bytes)` first does not make `catch Error` unreachable.

The reverse surprise also matters: specialized catches are not pattern matching by Solidity error name. A custom error does not match a custom named catch. Solidity only has the built-in Error and Panic catch forms plus the raw bytes fallback. If there is no bytes fallback, many nonmatching payloads are re-raised.

The audit model should be:

1. `try` is only available for specific high-level expression kinds.
2. It catches callee reverts, not every failure around the call expression.
3. Success-path return decoding can revert before catch dispatch.
4. `catch (bytes)` is the broad catch for revert payloads, but not for pre-dispatch decode failures.
5. Catch source order is cosmetic for Error/Panic/bytes priority.

When you need to tolerate malformed return data, use a low-level call and inspect `ok` and `returndata.length` manually. That gives up typed return decoding, but it moves the boundary to the place you actually need it.

## Where It Goes Wrong

### wrapping a low-level call in `try`

```solidity
try token.call(data) returns (bool ok, bytes memory ret) {
    ...
} catch {
    ...
}
```

This does not compile. The fix is not to remove error handling; the fix is to choose the right boundary. Either use a high-level interface call, or perform the low-level call and inspect `(ok, ret)` yourself.

### assuming `catch` handles malformed success returndata

```solidity
try oracle.latestAnswer() returns (uint256 price) {
    return price;
} catch {
    return fallbackPrice;
}
```

If the oracle address returns success with empty or malformed data, the return decoder can revert before the catch dispatch. The fallback is skipped.

### successful EOAs with expected return values

```solidity
interface I {
    function value() external returns (uint256);
}

function read(address target) external returns (uint256) {
    try I(target).value() returns (uint256 x) {
        return x;
    } catch {
        return 0;
    }
}
```

Calling an EOA can produce a successful low-level CALL with no returndata. Because the caller expects a `uint256`, the decode can fail before the catch. This is one of the nastier cases because the target did not revert and may not even contain code.

### dynamic return values with malicious offsets

```solidity
interface I {
    function metadata() external returns (bytes memory);
}

try I(target).metadata() returns (bytes memory data) {
    return data.length;
} catch {
    return 0;
}
```

A target can return success with a malformed ABI payload: an offset outside the returned buffer, a short tail, or a length that points past the end. The dynamic decoder fails before catch dispatch just like the static short-return case.

### catching only `Error(string)`

```solidity
try target.f() {
    ...
} catch Error(string memory reason) {
    emit Failed(reason);
}
```

This misses panics, custom errors, bare reverts, malformed Error payloads, and unknown selectors. If the caller should continue for all callee reverts, include `catch (bytes memory data)`.

### truncated `Error` or `Panic` payloads

```solidity
try target.f() {
    ...
} catch Error(string memory reason) {
    emit Reason(reason);
} catch Panic(uint256 code) {
    emit PanicCode(code);
} catch (bytes memory raw) {
    emit Raw(raw);
}
```

The selector alone is not enough. If revert data starts with the Error selector but is too short to decode a string, the Error clause does not run. The same applies to a truncated Panic payload. These malformed payloads fall through to `catch (bytes)` if it exists; otherwise they can be re-raised.

### expecting `catch (bytes)` source order to shadow typed catches

```solidity
try target.f() {
    ...
} catch (bytes memory) {
    return 1;
} catch Panic(uint256) {
    return 2;
}
```

For a Panic payload this returns `2`, not `1`. Solidity dispatches by clause kind, not by source order.

### treating custom errors as catchable by name

```solidity
error NotAllowed(address user);

try target.f() {
    ...
} catch NotAllowed(address user) {
    ...
}
```

Solidity does not support this catch form. Custom errors are handled through `catch (bytes)` and decoded manually if needed.

### using `try this.internalWrapper()` to catch internal failures

```solidity
function wrapper() external {
    _doWork();
}

function run() external {
    try this.wrapper() {
        ...
    } catch {
        ...
    }
}
```

This turns an internal call into an external call to self. That changes `msg.sender`, gas behavior, reentrancy shape, visibility, and construction-time behavior. It may catch the revert, but it is not semantically equivalent to catching an internal function.

### catching a wrapper instead of the operation you care about

```solidity
function safeCall(address target, bytes calldata data)
    external
    returns (bool ok, bytes memory ret)
{
    return target.call(data);
}

try this.safeCall(target, data) returns (bool ok, bytes memory ret) {
    require(ok, "call failed");
} catch {
    ...
}
```

This compiles because `this.safeCall` is a high-level external call. But the low-level failure is now encoded as `ok == false`, not as a caught revert. The catch only handles the wrapper itself reverting or failing to return valid data.

### relying on constructor `try/catch` as a deployment firewall

```solidity
try new Child(arg) returns (Child child) {
    children.push(child);
} catch {
    children.push(defaultChild);
}
```

This catches constructor reverts, but it does not make all creation failures equal. ABI encoding of constructor args, value transfer constraints, code-size issues, and downstream malformed data can still surprise the caller.

### assuming a catch block makes state changes atomic

```solidity
reserved[id] = true;
try minter.mint(id) {
    ownerOf[id] = msg.sender;
} catch {
    emit MintSkipped(id);
}
```

If `mint` fails and the catch continues, the pre-call state remains changed unless you undo it. `try/catch` is control flow, not a transaction-local rollback boundary for the caller's own writes.

### decoding raw catch bytes unsafely

```solidity
try target.f() {
    ...
} catch (bytes memory data) {
    bytes4 selector = bytes4(data);
    if (selector == 0x08c379a0) {
        string memory reason = abi.decode(data[4:], (string));
        emit Failed(reason);
    }
}
```

This can revert inside the catch if `data` is shorter than four bytes or has an Error selector with malformed payload. A robust raw catch treats the bytes as hostile input and length-checks before decoding.

The useful way to think about `try/catch` is not "exception handling for Solidity". It is "typed external-call revert dispatch, after some compiler-selected work has already happened". Once you hold that model, the odd cases stop being odd: low-level calls are outside the allowlist, successful malformed returndata is too early for the catch, and custom errors are just bytes unless you decode them.
