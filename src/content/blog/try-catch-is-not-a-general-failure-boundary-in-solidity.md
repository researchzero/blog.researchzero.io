---
title: "Solidity Try/Catch: What It Does and Does Not Catch"
description: "Solidity try/catch catches some external call failures, but it is not a general exception handler. This article explains where the boundary is, with examples."
date: 2026-05-20
author: "ResearchZero"
tags: ["solidity", "security", "auditing", "evm"]
---

Solidity has a `try/catch` statement, but it does not behave like exception handling in JavaScript, Python, or Java.

The most important thing to know is this:

`try/catch` in Solidity only catches failures from certain external operations. It does not catch every error that happens while evaluating the `try` statement, and it does not protect the caller from every bad response the callee can return.

This article explains what Solidity `try/catch` catches, what it does not catch, and the common mistakes auditors should look for.

## The short version

Solidity `try/catch` can be used with:

1. High-level external function calls
2. Contract creation with `new`
3. High-level external library calls that compile to `delegatecall`

It cannot be used directly with:

1. `address.call`
2. `address.staticcall`
3. `address.delegatecall`
4. Internal function calls

It also does not catch every failure related to a high-level external call. In particular, if the external call succeeds but returns malformed data, the caller can revert while decoding the return value, and the `catch` block will not run.

## Basic example of try/catch

Here is the normal use case:

```solidity
interface ITarget {
    function mint() external returns (uint256);
}

contract Caller {
    function callMint(address target) external returns (uint256) {
        try ITarget(target).mint() returns (uint256 id) {
            return id;
        } catch {
            return 0;
        }
    }
}
```

If `target.mint()` reverts, the `catch` block runs and the function returns `0`.

This is the mental model most developers have:

1. Try the external call.
2. If the external call reverts, run the catch block.
3. Otherwise, use the returned value.

That model is useful, but incomplete.

## 1. try/catch does not work with low-level calls

The following code does not compile:

```solidity
contract Caller {
    function callToken(address token, bytes calldata data) external {
        try token.call(data) returns (bool ok, bytes memory ret) {
            // ...
        } catch {
            // ...
        }
    }
}
```

The reason is that `token.call(data)` is a low-level call. Solidity only allows `try` on a high-level external call, contract creation, or an external library call.

For low-level calls, the error boundary is already expressed in the return values:

```solidity
contract Caller {
    function callToken(address token, bytes calldata data)
        external
        returns (bool ok, bytes memory ret)
    {
        (ok, ret) = token.call(data);

        if (!ok) {
            // ret contains the revert data, if any
            return (false, ret);
        }

        return (true, ret);
    }
}
```

In a low-level call, the EVM call failure is represented by `ok == false`. There is no need for a `catch` block because the low-level call itself does not bubble the revert.

## 2. try/catch can miss malformed success return data

This is the most surprising case.

Consider the following interface:

```solidity
interface IValue {
    function value() external returns (uint256);
}
```

The caller expects the external contract to return a `uint256`:

```solidity
contract Caller {
    function read(address target) external returns (uint256) {
        try IValue(target).value() returns (uint256 x) {
            return x;
        } catch {
            return 999;
        }
    }
}
```

Now suppose the target returns successfully, but returns no bytes:

```solidity
contract EmptyReturn {
    fallback() external {
        assembly {
            return(0, 0)
        }
    }
}
```

Calling `read(address(new EmptyReturn()))` does not return `999`.

It reverts.

The external call did not fail. It returned success with empty returndata. After the call succeeds, Solidity tries to decode the returned bytes as a `uint256`. Since zero bytes cannot be decoded as a `uint256`, the caller reverts before the `catch` block gets control.

So the `catch` block catches a callee revert, but it does not catch every caller-side decoding failure.

## 3. Calling an EOA can also bypass the catch block

An externally owned account has no code, but a high-level call to an address with no code can still produce a successful low-level call with empty return data.

This matters when the interface expects a return value:

```solidity
interface IOracle {
    function latestAnswer() external returns (uint256);
}

contract PriceReader {
    function price(address oracle) external returns (uint256) {
        try IOracle(oracle).latestAnswer() returns (uint256 answer) {
            return answer;
        } catch {
            return 0;
        }
    }
}
```

If `oracle` is an EOA or another address that returns success with no data, the caller can revert while decoding `answer`. The fallback value `0` is not returned.

This is a common audit issue when a contract assumes `try/catch` makes arbitrary addresses safe to call.

## 4. Dynamic return values can fail in more ways

Malformed return data is not limited to static values like `uint256`.

Dynamic types such as `bytes`, `string`, and arrays include offsets and lengths in their ABI encoding. A malicious target can return data with an invalid offset, a length that points past the end of returndata, or a truncated tail.

```solidity
interface IMetadata {
    function metadata() external returns (bytes memory);
}

contract Reader {
    function read(address target) external returns (uint256) {
        try IMetadata(target).metadata() returns (bytes memory data) {
            return data.length;
        } catch {
            return 0;
        }
    }
}
```

If the call succeeds but the returned bytes are not valid ABI encoding for `bytes`, the caller can revert during return-data decoding. Again, the catch block is skipped.

When the caller needs to tolerate malformed returndata, use a low-level call and validate the bytes manually.

```solidity
contract Reader {
    function read(address target) external returns (bool ok, bytes memory data) {
        (ok, data) = target.call(abi.encodeWithSignature("metadata()"));

        if (!ok) {
            return (false, data);
        }

        if (data.length < 32) {
            return (false, data);
        }

        // Additional ABI validation is needed before decoding dynamic data.
        return (true, data);
    }
}
```

The tradeoff is that the caller gives up automatic typed decoding. That is exactly why this approach is safer when the returndata may be hostile.

## 5. try/catch does not catch errors inside the try block

The `catch` block catches the external call failure. It does not catch arbitrary errors in the caller's own logic.

```solidity
contract Caller {
    uint256 public total;

    function run(address target) external {
        try IValue(target).value() returns (uint256 x) {
            total += x;

            // This revert is not caught by the catch block below.
            require(x != 13, "bad value");
        } catch {
            total = 0;
        }
    }
}
```

If `target.value()` returns `13`, the `require` inside the success branch reverts the whole transaction. The catch block does not run because the external call succeeded.

The same applies to errors inside the `catch` block itself. A `catch` block is ordinary Solidity code. If it reverts, there is no second catch block around it.

## 6. catch clauses are not ordered like normal if statements

Solidity has three useful catch forms:

```solidity
catch Error(string memory reason) {
    // revert("reason") or require(false, "reason")
}

catch Panic(uint256 code) {
    // assert failure, arithmetic overflow in checked math, division by zero, etc.
}

catch (bytes memory data) {
    // raw revert data
}
```

It is tempting to think source order controls which catch block runs. For example:

```solidity
try target.fail() {
    return 1;
} catch (bytes memory) {
    return 2;
} catch Error(string memory) {
    return 3;
}
```

If `target.fail()` reverts with `Error("failed")`, this returns `3`, not `2`.

Solidity dispatches to the typed `Error(string)` and `Panic(uint256)` catch clauses when the revert data matches those built-in formats. The raw `bytes` catch is the fallback for revert payloads that do not match a more specific catch.

The raw bytes catch is broad, but it is not a source-order override.

## 7. catch Error(string) is not a general catch

This catches only the built-in Solidity error format for reason strings:

```solidity
try target.f() {
    // ...
} catch Error(string memory reason) {
    emit Failed(reason);
}
```

It does not catch:

1. `Panic(uint256)` errors
2. Custom errors
3. `revert()` with no data
4. Assembly reverts with arbitrary bytes
5. Malformed `Error(string)` payloads

If the caller should continue after any callee revert, include a raw bytes catch:

```solidity
try target.f() {
    // ...
} catch Error(string memory reason) {
    emit FailedWithReason(reason);
} catch Panic(uint256 code) {
    emit FailedWithPanic(code);
} catch (bytes memory data) {
    emit FailedWithBytes(data);
}
```

The final `catch (bytes memory data)` is the broad catch for revert data. It still does not catch successful malformed return data from the success path described earlier.

## 8. Custom errors are caught as bytes

Solidity custom errors are ABI-encoded revert data. They are not catchable by name.

This does not compile:

```solidity
error NotAllowed(address user);

try target.f() {
    // ...
} catch NotAllowed(address user) {
    // ...
}
```

To handle custom errors, catch the raw bytes and decode them carefully:

```solidity
error NotAllowed(address user);

bytes4 constant NOT_ALLOWED_SELECTOR = NotAllowed.selector;

try target.f() {
    // ...
} catch (bytes memory data) {
    if (data.length >= 4 && bytes4(data) == NOT_ALLOWED_SELECTOR) {
        // Decode only after validating the expected length and format.
    }
}
```

The selector is only the first four bytes. Before decoding arguments, the contract must check that the payload has the expected length and structure.

## 9. Decoding catch bytes can revert too

The raw bytes in a catch block are untrusted input. A malicious callee can return any revert payload it wants.

This is unsafe:

```solidity
try target.f() {
    // ...
} catch (bytes memory data) {
    string memory reason = abi.decode(data[4:], (string));
    emit Failed(reason);
}
```

The code assumes:

1. `data` has at least 4 bytes
2. The first 4 bytes are the selector for `Error(string)`
3. The remaining bytes are valid ABI encoding for a string

If any of those assumptions are false, the catch block can revert.

A safer version checks the selector and length first:

```solidity
bytes4 constant ERROR_SELECTOR = bytes4(keccak256("Error(string)"));

try target.f() {
    // ...
} catch (bytes memory data) {
    if (data.length >= 4 && bytes4(data) == ERROR_SELECTOR) {
        // More validation is needed before decoding a dynamic string.
    }

    emit FailedRaw(data);
}
```

In most contracts, emitting or storing the raw bytes is safer than decoding every possible format on-chain.

## 10. try this.wrapper() changes the call

Developers sometimes try to catch internal failures by moving the logic into an external function and calling `this`.

```solidity
contract Worker {
    function wrapper() external {
        _doWork();
    }

    function run() external {
        try this.wrapper() {
            // ...
        } catch {
            // ...
        }
    }

    function _doWork() internal {
        // ...
    }
}
```

This can catch a revert from `wrapper()`, but it is not the same as calling `_doWork()` internally.

The call to `this.wrapper()` is an external call to the same contract. That changes the execution context:

1. `msg.sender` becomes the contract itself
2. The call goes through external ABI encoding and decoding
3. Reentrancy assumptions can change
4. Gas behavior can change
5. The pattern does not work the same way during construction

This pattern should be treated as an external self-call, not as a harmless internal try/catch.

## 11. try/catch is not a rollback boundary for the caller

The external call may revert and get caught, but state changes made by the caller before the external call are not automatically undone.

```solidity
contract Minter {
    mapping(uint256 => bool) public reserved;

    function mint(address target, uint256 id) external {
        reserved[id] = true;

        try ITarget(target).mint() returns (uint256) {
            // mint succeeded
        } catch {
            // mint failed, but reserved[id] is still true
        }
    }
}
```

If the catch block continues, `reserved[id]` remains `true`. The caller must explicitly undo or account for its own state changes.

`try/catch` is control flow. It is not a transaction-local checkpoint.

## 12. Constructor try/catch has the same limitations

Solidity allows `try/catch` around contract creation:

```solidity
contract Factory {
    Child public child;

    function deploy(uint256 arg) external {
        try new Child(arg) returns (Child deployed) {
            child = deployed;
        } catch {
            // deployment failed
        }
    }
}
```

This can catch a revert from the child constructor.

However, it should not be treated as a complete deployment firewall. The caller can still run into issues around argument encoding, value transfer constraints, code-size limits, and caller-side logic in the success or catch branches.

The same rule applies: only the failure at the allowed external operation is caught.

## Audit checklist

When reviewing Solidity `try/catch`, ask the following questions:

1. Is the expression inside `try` actually a high-level external call or contract creation?
2. Does the code assume low-level calls can be wrapped in `try/catch`?
3. Does the interface expect return values from an arbitrary or untrusted address?
4. Can a successful call return empty or malformed returndata?
5. Does the code catch only `Error(string)` when it should also handle panics, custom errors, or raw revert data?
6. Does the catch block decode raw bytes without validating length and selector?
7. Does the contract assume `catch (bytes)` catches malformed success return data?
8. Does `try this.someFunction()` accidentally change `msg.sender` or reentrancy assumptions?
9. Are caller-side state changes before the external call still correct if the catch block continues?

## Conclusion

The best way to think about Solidity `try/catch` is:

`try/catch` catches certain external call reverts. It is not a general failure boundary.

If the callee reverts, a matching catch block can handle the revert data. If the callee returns success with malformed returndata, the caller can still revert during ABI decoding. If the caller's own code reverts inside the success or catch block, that revert is not caught either.

For trusted interfaces, high-level `try/catch` is convenient. For hostile or arbitrary targets, especially when return data matters, a low-level call with explicit returndata validation is usually the more accurate boundary.
