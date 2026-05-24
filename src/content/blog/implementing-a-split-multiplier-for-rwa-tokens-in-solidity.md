---
title: "Implementing a Split Multiplier for RWA Tokens in Solidity"
description: "How to implement stock splits and reverse splits for tokenized real-world assets using raw balances, raw allowances, and a global split multiplier."
date: 2026-05-24
author: "ResearchZero"
tags: ["solidity", "rwa", "erc-20", "tokenization"]
---

# Implementing a Split Multiplier for RWA Tokens in Solidity

Real world assets sometimes change the number of units outstanding without changing the proportional ownership of the holders.

The common example is a stock split:

- In a 2-for-1 split, someone who had 100 shares now has 200 shares.
- In a 1-for-10 reverse split, someone who had 100 shares now has 10 shares.

Economically, nothing was transferred between holders. If Alice owned 1% of the company before the split, she still owns 1% after the split. The unit of account changed.

If we tokenize stocks or other real world assets as ERC-20s, we need a way to represent these split events without iterating over every holder. Iterating over all holders is not possible onchain because the holder set may be too large, and Ethereum contracts generally do not have a native way to enumerate mapping keys.

The usual solution is to store balances in an internal accounting unit and expose user-facing balances through a global split multiplier.

This article explains how to implement that pattern, and more importantly, how it should interact with `balanceOf`, `approve`, `allowance`, `transfer`, and `transferFrom`.

## The naive implementation does not work

A normal ERC-20 balance mapping looks like this:

```solidity
mapping(address => uint256) internal _balances;
uint256 internal _totalSupply;
```

If a 2-for-1 split happens, the naive approach is to double every balance:

```solidity
_balances[alice] *= 2;
_balances[bob] *= 2;
_balances[charlie] *= 2;
```

This is not a real implementation. The contract does not know every address that has ever received tokens unless we build and maintain an enumerable holder list, and even then the operation may exceed the block gas limit.

The same problem appears for reverse splits. A 1-for-10 reverse split would require dividing every holder balance by 10.

We need the effect of updating every balance without actually updating every balance.

## Store raw balances, expose split-adjusted balances

Instead of storing the displayed balance directly, store a raw balance.

The raw balance never changes during a split. Only the global multiplier changes.

```solidity
uint256 internal constant SCALE = 1e18;

mapping(address => uint256) internal _rawBalances;
uint256 internal _rawTotalSupply;

uint256 public splitMultiplier = SCALE;
```

The user-facing balance is:

```solidity
displayedBalance = rawBalance * splitMultiplier / SCALE;
```

At deployment, `splitMultiplier` is `1e18`, so raw balances and displayed balances are equal.

If a 2-for-1 split happens, multiply `splitMultiplier` by 2:

```solidity
splitMultiplier = splitMultiplier * 2;
```

Now every displayed balance doubles, even though `_rawBalances` did not change.

If a 1-for-10 reverse split happens, divide `splitMultiplier` by 10:

```solidity
splitMultiplier = splitMultiplier / 10;
```

Now every displayed balance is divided by 10.

This gives us an O(1) split.

## A concrete example

Suppose the token represents a stock-like RWA and has 18 decimals. Alice has 100 tokens and Bob has 50 tokens.

Internally:

```text
splitMultiplier = 1e18

rawBalance[Alice] = 100e18
rawBalance[Bob]   =  50e18
```

The displayed balances are:

```text
balanceOf(Alice) = 100e18 * 1e18 / 1e18 = 100e18
balanceOf(Bob)   =  50e18 * 1e18 / 1e18 =  50e18
```

Now the issuer performs a 4-for-1 split.

```text
splitMultiplier = 4e18
```

The raw balances did not change:

```text
rawBalance[Alice] = 100e18
rawBalance[Bob]   =  50e18
```

But the displayed balances are now:

```text
balanceOf(Alice) = 100e18 * 4e18 / 1e18 = 400e18
balanceOf(Bob)   =  50e18 * 4e18 / 1e18 = 200e18
```

Alice and Bob own the same percentage of the asset as before. Only the number of displayed units changed.

## The key conversion functions

We need two conversions:

- raw to displayed
- displayed to raw

The first conversion is used by view functions such as `balanceOf`, `totalSupply`, and `allowance`.

The second conversion is used by state-changing functions such as `transfer`, `transferFrom`, `approve`, `mint`, and `burn`.

```solidity
function _toDisplayed(uint256 rawAmount) internal view returns (uint256) {
    return rawAmount * splitMultiplier / SCALE;
}

function _toRaw(uint256 displayedAmount) internal view returns (uint256) {
    return displayedAmount * SCALE / splitMultiplier;
}
```

However, this version is only the accounting formula. In production, the multiplication should either be protected by explicit supply and multiplier caps, or implemented with a full-precision `mulDiv` helper from a well-audited math library. Otherwise an extreme multiplier or raw amount can make view functions revert through arithmetic overflow.

It also silently rounds down. That can be dangerous when moving value.

Suppose `splitMultiplier` is `3e18` after a 3-for-1 split. A displayed amount of `1` smallest unit converts to:

```text
1 * 1e18 / 3e18 = 0
```

If `transfer(1)` converts to zero raw units, a user can emit transfers without changing balances. In other cases, rounding can leave value behind in surprising ways.

For state-changing operations, it is often better to require an exact conversion. With OpenZeppelin's `Math.mulDiv`, the check can avoid both silent rounding and multiplication overflow:

```solidity
error NonRepresentableAmount();

function _toRawExact(uint256 displayedAmount) internal view returns (uint256 rawAmount) {
    if (mulmod(displayedAmount, SCALE, splitMultiplier) != 0) {
        revert NonRepresentableAmount();
    }

    rawAmount = Math.mulDiv(displayedAmount, SCALE, splitMultiplier);
}
```

This means the contract refuses to transfer, approve, mint, or burn an amount that cannot be represented exactly in raw units.

With 18 decimals, this is usually not a practical limitation. But it is important for correctness.

## Full minimal implementation

The implementation below is intentionally compact. It omits access control details, sanctions logic, offchain proof systems, corporate action governance, custody mechanics, and supply caps. The point is to focus on the split multiplier.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract SplitAdjustedRwaToken {
    uint256 internal constant SCALE = 1e18;

    string public name;
    string public symbol;
    uint8 public immutable decimals = 18;

    address public admin;

    uint256 public splitMultiplier = SCALE;

    uint256 internal _rawTotalSupply;
    mapping(address => uint256) internal _rawBalances;
    mapping(address => mapping(address => uint256)) internal _rawAllowances;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event SplitMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier);

    error NotAdmin();
    error ZeroAddress();
    error NonRepresentableAmount();
    error InsufficientBalance();
    error InsufficientAllowance();
    error InvalidMultiplier();
    error SplitWouldLosePrecision();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
        admin = msg.sender;
    }

    function totalSupply() external view returns (uint256) {
        return _toDisplayed(_rawTotalSupply);
    }

    function balanceOf(address account) external view returns (uint256) {
        return _toDisplayed(_rawBalances[account]);
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _toDisplayed(_rawAllowances[owner][spender]);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();

        uint256 rawAmount = _toRawExact(amount);
        _rawAllowances[msg.sender][spender] = rawAmount;

        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 rawAmount = _toRawExact(amount);

        if (msg.sender != from) {
            uint256 rawAllowance = _rawAllowances[from][msg.sender];
            if (rawAllowance < rawAmount) revert InsufficientAllowance();

            unchecked {
                _rawAllowances[from][msg.sender] = rawAllowance - rawAmount;
            }

            emit Approval(from, msg.sender, _toDisplayed(_rawAllowances[from][msg.sender]));
        }

        _transferRaw(from, to, rawAmount, amount);
        return true;
    }

    function mint(address to, uint256 amount) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();

        uint256 rawAmount = _toRawExact(amount);
        _rawTotalSupply += rawAmount;
        _rawBalances[to] += rawAmount;

        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external onlyAdmin {
        if (from == address(0)) revert ZeroAddress();

        uint256 rawAmount = _toRawExact(amount);
        uint256 rawBalance = _rawBalances[from];
        if (rawBalance < rawAmount) revert InsufficientBalance();

        unchecked {
            _rawBalances[from] = rawBalance - rawAmount;
            _rawTotalSupply -= rawAmount;
        }

        emit Transfer(from, address(0), amount);
    }

    function applySplit(uint256 numerator, uint256 denominator) external onlyAdmin {
        if (numerator == 0 || denominator == 0) revert InvalidMultiplier();

        uint256 oldMultiplier = splitMultiplier;
        if (mulmod(oldMultiplier, numerator, denominator) != 0) {
            revert SplitWouldLosePrecision();
        }

        uint256 newMultiplier = Math.mulDiv(oldMultiplier, numerator, denominator);
        if (newMultiplier == 0) revert InvalidMultiplier();

        splitMultiplier = newMultiplier;

        emit SplitMultiplierUpdated(oldMultiplier, newMultiplier);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        uint256 rawAmount = _toRawExact(amount);
        _transferRaw(from, to, rawAmount, amount);
    }

    function _transferRaw(
        address from,
        address to,
        uint256 rawAmount,
        uint256 displayedAmount
    ) internal {
        if (from == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();

        uint256 rawBalance = _rawBalances[from];
        if (rawBalance < rawAmount) revert InsufficientBalance();

        unchecked {
            _rawBalances[from] = rawBalance - rawAmount;
            _rawBalances[to] += rawAmount;
        }

        emit Transfer(from, to, displayedAmount);
    }

    function _toDisplayed(uint256 rawAmount) internal view returns (uint256) {
        return Math.mulDiv(rawAmount, splitMultiplier, SCALE);
    }

    function _toRawExact(uint256 displayedAmount) internal view returns (uint256 rawAmount) {
        if (mulmod(displayedAmount, SCALE, splitMultiplier) != 0) {
            revert NonRepresentableAmount();
        }

        rawAmount = Math.mulDiv(displayedAmount, SCALE, splitMultiplier);
    }
}
```

This is the whole idea:

- `balanceOf` multiplies raw balances by the current multiplier.
- `totalSupply` multiplies raw total supply by the current multiplier.
- `allowance` multiplies raw allowances by the current multiplier.
- `transfer` converts the displayed amount to raw units, then moves raw units.
- `approve` converts the displayed allowance to raw units, then stores raw units.
- a split only changes `splitMultiplier`.

## How balances should work

The balance mapping should not be rewritten during a split.

The invariant is:

```text
balanceOf(user) = rawBalance[user] * splitMultiplier / SCALE
```

This implies a 2-for-1 split is just:

```text
splitMultiplier = splitMultiplier * 2
```

and a 1-for-10 reverse split is:

```text
splitMultiplier = splitMultiplier / 10
```

No individual holder storage is touched.

This matters because transfers after the split must behave as if every account had already been updated.

Suppose Alice has a raw balance of `100e18`.

Before a split:

```text
splitMultiplier = 1e18
balanceOf(Alice) = 100e18
```

After a 2-for-1 split:

```text
splitMultiplier = 2e18
balanceOf(Alice) = 200e18
```

If Alice transfers `40e18` displayed units, the contract converts it to raw:

```text
rawAmount = 40e18 * 1e18 / 2e18 = 20e18
```

Then the contract subtracts `20e18` raw units from Alice and adds `20e18` raw units to the receiver.

After the transfer:

```text
rawBalance[Alice] = 80e18
rawBalance[Bob]   = 20e18
```

Displayed:

```text
balanceOf(Alice) = 80e18 * 2e18 / 1e18 = 160e18
balanceOf(Bob)   = 20e18 * 2e18 / 1e18 =  40e18
```

That is exactly what we expect.

Alice had 200 displayed units and sent 40. She now has 160.

## How approvals should work

Approvals are more subtle than balances.

An allowance is a permission to spend a number of current token units. If the token undergoes a split, should the allowance split too?

For most split-adjusted RWA tokens, the answer should be yes.

If Alice approves a broker contract to spend 100 shares, and a 2-for-1 split happens, Alice's balance doubles. The approval should usually become 200 shares so that it preserves the same economic authorization.

This means allowances should be stored in raw units too.

```solidity
mapping(address => mapping(address => uint256)) internal _rawAllowances;
```

The view function should return the split-adjusted allowance:

```solidity
function allowance(address owner, address spender) external view returns (uint256) {
    return _toDisplayed(_rawAllowances[owner][spender]);
}
```

When Alice approves 100 tokens before any split:

```text
splitMultiplier = 1e18
approve(spender, 100e18)
rawAllowance[Alice][spender] = 100e18
allowance(Alice, spender) = 100e18
```

After a 2-for-1 split:

```text
splitMultiplier = 2e18
rawAllowance[Alice][spender] = 100e18
allowance(Alice, spender) = 200e18
```

The allowance doubled because the units doubled.

When the spender calls `transferFrom(Alice, Bob, 40e18)` after the split:

```text
rawAmount = 40e18 * 1e18 / 2e18 = 20e18
```

The contract subtracts `20e18` from the raw allowance. The remaining raw allowance is `80e18`, which displays as `160e18`.

So after spending 40 displayed units, the displayed allowance goes from 200 to 160.

That is the behavior users expect.

## What if approvals should not split?

There is another possible design: store allowances directly in displayed units, not raw units.

Under that design, if Alice approves 100 tokens and a 2-for-1 split happens, the allowance remains 100 tokens.

This may be desirable when approvals represent an order size, a regulatory limit, or a short-lived execution instruction rather than a proportional economic authorization.

But it creates a mismatch:

- balances are split-adjusted
- allowances are not split-adjusted

That is not wrong, but it must be intentional and documented. It also means the same word, "token", behaves differently in `balanceOf` and `allowance` across a split.

For most ERC-20 integrations, storing raw allowances is the cleaner model because `allowance` remains denominated in the same visible units as `balanceOf`.

## The normal approve race still exists

The split multiplier does not remove the standard ERC-20 approval overwrite race.

If Alice has approved a spender for 100 tokens and submits `approve(spender, 50)`, the spender may be able to spend the old allowance before the new approval is mined, then receive the new 50-token allowance afterward.

This is not specific to split-adjusted accounting, but it still matters here. Production contracts should either document the normal ERC-20 allowance semantics clearly or provide safer helpers such as `increaseAllowance`, `decreaseAllowance`, or a zero-first approval policy.

## The permit problem during reverse splits

`permit` adds another complication.

EIP-2612-style permits let a holder sign an approval offchain. A relayer or spender can later submit the signature onchain and create the allowance.

That delay is dangerous when a split can happen between signing and execution.

Suppose Alice has 100 tokens and signs a permit approving a broker for 100 tokens.

At the time she signs:

```text
splitMultiplier = 1e18
permit value = 100e18
```

Now a 1-for-10 reverse split happens before the permit is submitted.

Alice's displayed balance becomes:

```text
balanceOf(Alice) = 10e18
```

If the old permit is still valid, the spender can submit it after the reverse split:

```text
permit(owner = Alice, spender = Broker, value = 100e18)
```

The contract will interpret `100e18` as 100 post-split tokens. But Alice signed when 100 tokens represented her pre-split balance. After the reverse split, that same displayed number represents 10 times more economic value than Alice intended.

This is the stale permit problem.

Forward splits have the opposite effect: an old permit may become too small. That is inconvenient. Reverse splits are more dangerous because the old signed value can become too large.

If the token supports permit, the signed message should be bound to the split state.

This is not a drop-in EIP-2612 permit anymore, because the signed struct has an additional field. That compatibility tradeoff is usually worth it for an RWA token where reverse splits can materially change what a signed displayed amount means.

One simple pattern is to include a `splitEpoch` in a custom permit:

```solidity
uint256 public splitEpoch;

event SplitMultiplierUpdated(
    uint256 indexed splitEpoch,
    uint256 oldMultiplier,
    uint256 newMultiplier
);
```

Increment it whenever a split or reverse split is applied:

```solidity
function applySplit(uint256 numerator, uint256 denominator) external onlyAdmin {
    if (numerator == 0 || denominator == 0) revert InvalidMultiplier();

    uint256 oldMultiplier = splitMultiplier;
    if (mulmod(oldMultiplier, numerator, denominator) != 0) {
        revert SplitWouldLosePrecision();
    }

    uint256 newMultiplier = Math.mulDiv(oldMultiplier, numerator, denominator);
    if (newMultiplier == 0) revert InvalidMultiplier();

    splitMultiplier = newMultiplier;
    splitEpoch += 1;

    emit SplitMultiplierUpdated(splitEpoch, oldMultiplier, newMultiplier);
}
```

This example uses the same `SplitWouldLosePrecision` check as the minimal implementation. If the contract accepts arbitrary split ratios, do not silently round the multiplier in the same transaction that invalidates outstanding permits.

Then the permit signs the epoch:

```solidity
bytes32 public constant PERMIT_TYPEHASH =
    keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline,uint256 splitEpoch)"
    );
```

When verifying the permit, the contract checks that the signed epoch matches the current epoch:

```solidity
if (signedSplitEpoch != splitEpoch) {
    revert StalePermit();
}
```

This makes all outstanding permits expire automatically when a split occurs.

Another version is to include the current `splitMultiplier` in the signed message instead of `splitEpoch`. The epoch is usually cleaner because it is smaller, monotonic, and does not expose the signature format to multiplier precision choices.

Do not rely only on `deadline`. A permit with a 30-day deadline can still be dangerous if a reverse split happens five minutes after it is signed.

The rule is:

```text
If the unit of account changes, old signed approvals should not remain valid.
```

## Infinite approvals

Many ERC-20 contracts treat `type(uint256).max` as an infinite approval. If the allowance is infinite, `transferFrom` does not decrease it.

If you want that behavior, you need to decide whether the infinite value is stored as a raw amount or as a sentinel.

The safer pattern is to treat `type(uint256).max` as a sentinel:

```solidity
function allowance(address owner, address spender) external view returns (uint256) {
    uint256 rawAllowance = _rawAllowances[owner][spender];

    if (rawAllowance == type(uint256).max) {
        return type(uint256).max;
    }

    return _toDisplayed(rawAllowance);
}
```

Then `approve` can store the sentinel directly:

```solidity
function approve(address spender, uint256 amount) external returns (bool) {
    if (spender == address(0)) revert ZeroAddress();

    uint256 rawAmount = amount == type(uint256).max
        ? type(uint256).max
        : _toRawExact(amount);

    _rawAllowances[msg.sender][spender] = rawAmount;

    emit Approval(msg.sender, spender, amount);
    return true;
}
```

And `transferFrom` skips decrementing if the allowance is infinite:

```solidity
uint256 rawAllowance = _rawAllowances[from][msg.sender];

if (rawAllowance != type(uint256).max) {
    if (rawAllowance < rawAmount) revert InsufficientAllowance();

    unchecked {
        _rawAllowances[from][msg.sender] = rawAllowance - rawAmount;
    }
}
```

This avoids trying to multiply `type(uint256).max` by the split multiplier in `allowance`, which would overflow.

## Transfers should move raw units

Transfers receive displayed units from the caller:

```solidity
transfer(to, 50e18)
```

The caller is thinking in current token units, not raw accounting units. Therefore, the contract must convert the displayed amount to raw before touching storage.

```solidity
uint256 rawAmount = _toRawExact(amount);
_rawBalances[from] -= rawAmount;
_rawBalances[to] += rawAmount;
```

The transfer event should emit the displayed amount:

```solidity
emit Transfer(from, to, amount);
```

This is important because ERC-20 events are consumed by wallets, explorers, indexers, and accounting systems. If the user called `transfer(to, 50e18)`, the event should say `50e18`.

Do not emit the raw amount unless the token explicitly documents that events are raw. Most integrations will assume the `Transfer` value is in the same unit as `balanceOf`.

## Reverse splits and dust

Reverse splits introduce a problem that forward splits usually do not: small balances may become too small to display.

Suppose a token has zero decimals for simplicity.

Alice has 9 shares and the issuer performs a 1-for-10 reverse split. Alice should now have 0.9 shares, but if the token has zero decimals, it cannot represent 0.9.

With 18 decimals, the problem is much smaller, but it still exists at the smallest unit.

If the raw balance is:

```text
rawBalance[Alice] = 9
splitMultiplier = 1e17
```

then:

```text
balanceOf(Alice) = 9 * 1e17 / 1e18 = 0
```

Alice still has raw units, but her displayed ERC-20 balance rounds down to zero.

This is dust.

There are three common ways to handle dust:

1. Allow dust to remain until a future split or redemption makes it useful.
2. Provide an issuer-controlled cash-in-lieu process for fractional shares.
3. Use enough decimals that dust is economically irrelevant.

For RWA stocks, cash-in-lieu is often the real-world treatment for fractional entitlements after a reverse split. If the token is meant to closely model the real security, the smart contract should be paired with an offchain process for those residual amounts.

## Why exact conversion is safer than rounding

Rounding appears in two different places:

- when converting raw balances to displayed balances
- when converting displayed user inputs back to raw amounts

These two cases should not necessarily use the same policy.

For view functions like `balanceOf`, rounding down is unavoidable if the displayed amount is not exactly representable:

```solidity
function _toDisplayed(uint256 rawAmount) internal view returns (uint256) {
    return rawAmount * splitMultiplier / SCALE;
}
```

Solidity integer division rounds down, so `balanceOf` can hide residual dust at the smallest unit. This is acceptable if the token documents that small residuals may exist after reverse splits.

For state-changing functions, silent rounding is much more dangerous.

There are two tempting alternatives to `_toRawExact`.

The first is rounding down:

```solidity
rawAmount = displayedAmount * SCALE / splitMultiplier;
```

This can convert a nonzero displayed amount to zero raw units.

That creates a bad transfer:

```text
transfer(to, 1)

rawAmount = 1 * 1e18 / 3e18 = 0
```

The transaction could emit a `Transfer` event for `1`, but no ownership changed. Indexers may record movement that did not happen in the raw ledger.

The second is rounding up:

```solidity
rawAmount = (displayedAmount * SCALE + splitMultiplier - 1) / splitMultiplier;
```

This prevents zero-raw transfers, but it can charge slightly more raw value than the displayed amount requested.

That creates the opposite problem. The user requested a transfer of a certain displayed amount, but the contract removed a little more raw ownership than that displayed amount represents.

Neither behavior is ideal for a financial asset.

Reverting on non-exact amounts is easier to reason about:

```text
Either the displayed amount maps exactly to raw accounting units, or the operation fails.
```

For user interfaces, this means the frontend should query the current multiplier and avoid constructing non-representable amounts.

## Rounding policy for balances, approvals, and transfers

A split-adjusted token should choose one explicit rounding policy and apply it consistently.

A practical policy is:

```text
Views may round down.
State changes must be exact.
Corporate action settlement handles dust.
```

In this model:

- `balanceOf` rounds down because ERC-20 returns an integer.
- `totalSupply` rounds down for the same reason.
- `allowance` rounds down when displaying a raw allowance.
- `approve` reverts if the requested displayed amount cannot be converted exactly to raw units.
- `transfer` reverts if the requested displayed amount cannot be converted exactly to raw units.
- `transferFrom` reverts if the requested displayed amount cannot be converted exactly to raw units.
- `mint` and `burn` also use exact conversion.

This avoids creating or destroying raw ownership through user operations.

Consider a 3-for-1 split:

```text
splitMultiplier = 3e18
```

One raw unit now displays as three displayed units:

```text
displayed = raw * 3e18 / 1e18
```

Transferring `3` displayed units maps exactly to `1` raw unit:

```text
raw = 3 * 1e18 / 3e18 = 1
```

Transferring `1` displayed unit does not:

```text
raw = 1 * 1e18 / 3e18 = 0.333...
```

The contract should reject the second transfer.

The same logic applies to approvals. If Alice approves `1` displayed unit when the multiplier is `3e18`, the contract cannot store exactly one third of a raw allowance. Storing zero is misleading, and storing one raw unit grants an allowance worth three displayed units.

So `approve(1)` should revert, while `approve(3)` should succeed.

This may feel strict, but it is the cleanest way to keep the raw ledger exact.

## Rounding and total supply

There is one subtle consequence of rounding down displayed balances: the sum of all displayed balances may be less than `totalSupply()`, or both may be less than the exact economic supply.

Suppose two users each have one raw unit and the multiplier is `0.5e18`.

```text
rawBalance[Alice] = 1
rawBalance[Bob]   = 1
rawTotalSupply    = 2
splitMultiplier   = 0.5e18
```

Each displayed balance rounds down:

```text
balanceOf(Alice) = 1 * 0.5e18 / 1e18 = 0
balanceOf(Bob)   = 1 * 0.5e18 / 1e18 = 0
```

But total supply is:

```text
totalSupply() = 2 * 0.5e18 / 1e18 = 1
```

The sum of displayed balances is zero, but `totalSupply()` is one.

This is not a solvency issue. The raw ledger still balances:

```text
rawBalance[Alice] + rawBalance[Bob] = rawTotalSupply
```

It is a display precision issue caused by integer division.

For this reason, tests should not assert that the sum of rounded `balanceOf` values always equals rounded `totalSupply()` after reverse splits. The stronger invariant is in raw units.

```text
sum(raw balances) == rawTotalSupply
```

If the product needs displayed balances to always sum exactly to displayed total supply, the contract needs a dust allocation policy. For example, it can assign residual units to a treasury, a claims contract, or a cash-in-lieu settlement process. That is a product and legal decision, not just a Solidity decision.

## Rounding and events

Events should use the exact displayed amount supplied by the user when the raw conversion succeeds.

For example:

```text
transfer(to, 30e18)
rawAmount = 10e18
emit Transfer(msg.sender, to, 30e18)
```

This is correct because the displayed amount maps exactly to the raw amount.

If the displayed amount does not map exactly to raw units, the transaction should revert before emitting an event.

This rule prevents events from lying about the raw ledger. A `Transfer` event should correspond to a real ownership movement, not a rounded approximation.

## Split events are not ERC-20 Transfer events

A stock split changes every displayed balance, but it is not a transfer.

No holder sent tokens to another holder. No mint occurred in the economic sense. No burn occurred in the economic sense.

Therefore, a split should not emit a `Transfer` event for every holder. That would be impossible, and it would also misrepresent what happened.

Emit a dedicated event instead:

```solidity
event SplitMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier);
```

Indexers that care about historical balances must process this event together with `Transfer` events.

This is the same general idea behind rebasing tokens: a balance can change because the global accounting index changed, not because the account participated in a transfer.

## Important invariant

The most important invariant is that raw ownership does not change during a split.

For every account:

```text
rawBalanceBefore[account] == rawBalanceAfter[account]
```

Only this changes:

```text
splitMultiplierBefore != splitMultiplierAfter
```

The total supply view changes according to the multiplier:

```text
totalSupply() = rawTotalSupply * splitMultiplier / SCALE
```

But `_rawTotalSupply` does not change during a split.

This distinction is crucial. If the contract changes `_rawTotalSupply` during a split, then transfers and allowances will no longer preserve proportional ownership cleanly.

## Testing the behavior

A good test suite should cover the split multiplier directly.

For balances:

```text
Given Alice has 100 tokens
When a 2-for-1 split is applied
Then balanceOf(Alice) is 200 tokens
And Alice's raw balance is unchanged
```

For transfers:

```text
Given Alice has 100 tokens
And a 2-for-1 split is applied
When Alice transfers 40 tokens to Bob
Then Alice has 160 tokens
And Bob has 40 tokens
```

For approvals:

```text
Given Alice approves Spender for 100 tokens
And a 2-for-1 split is applied
Then allowance(Alice, Spender) is 200 tokens
When Spender transfers 40 tokens from Alice
Then allowance(Alice, Spender) is 160 tokens
```

For reverse splits:

```text
Given Alice has 100 tokens
When a 1-for-10 reverse split is applied
Then balanceOf(Alice) is 10 tokens
```

For rounding:

```text
Given the current multiplier makes 1 wei non-representable in raw units
When Alice transfers 1 wei
Then the transaction reverts
```

For split precision:

```text
Given a split ratio would require rounding the stored multiplier
When the issuer applies the split
Then the transaction reverts or uses a rational accounting path
```

For permits:

```text
Given Alice signs a permit at splitEpoch 1
And the issuer applies a split, moving to splitEpoch 2
When the spender submits the old permit
Then the transaction reverts
```

For approvals:

```text
Given Alice changes an existing nonzero allowance
When the spender races the allowance update
Then tests should document whether the contract follows standard ERC-20 overwrite semantics or uses safer allowance helpers
```

These tests are not just implementation checks. They define the accounting model.

## Security considerations

The split multiplier is a privileged variable. Whoever can update it can change every displayed balance and allowance in the system.

For an RWA token, the update mechanism should usually have:

- clear access control
- operational review
- event emission
- offchain corporate action documentation
- monitoring by indexers and custodians
- possibly a timelock, depending on the product

The contract should also protect against invalid multipliers:

- zero multipliers
- overflows during multiplication
- unintended precision loss
- split ratios that make common user amounts non-representable
- stale signed approvals, including permits submitted after the split state changed
- the normal ERC-20 approval overwrite race
- view-function denial of service if displayed balance calculations can overflow
- direct multiplier setters that bypass the same validation and permit-invalidation path as normal split operations

Solidity 0.8+ catches arithmetic overflow by default, but that only changes a bad calculation into a revert. It does not prevent bad financial parameters. Governance, validation, supply caps, multiplier caps, and full-precision math still matter.

## A note on multiplier precision

The sample contract stores the multiplier as one `uint256` scaled by `1e18`.

That is fine for simple splits like:

- 2-for-1
- 3-for-2
- 1-for-10
- 1-for-100

But some ratios do not fit exactly into a decimal fixed-point number. For example, a 1-for-3 reverse split produces a repeating decimal:

```text
1 / 3 = 0.333333333333...
```

If the contract stores only:

```text
333333333333333333
```

then it has rounded the multiplier down.

For production systems that need exact accounting across arbitrary corporate actions, store the cumulative split as a rational number instead:

```solidity
uint256 public splitNumerator = 1;
uint256 public splitDenominator = 1;
```

Then:

```text
displayed = raw * splitNumerator / splitDenominator
raw = displayed * splitDenominator / splitNumerator
```

The same ideas in this article still apply. The only difference is that the conversion functions use a numerator and denominator instead of a single fixed-point multiplier.

The tradeoff is that rational accounting needs more careful overflow handling. In production, use `mulDiv` from a well-audited math library rather than plain multiplication followed by division.

## Summary

A split-adjusted RWA ERC-20 should not loop over holders when a stock split or reverse split occurs.

Instead, it should store raw balances and raw allowances, then expose user-facing values through a global split multiplier.

The essential formulas are:

```text
balanceOf(user) = rawBalance[user] * splitMultiplier / SCALE
allowance(owner, spender) = rawAllowance[owner][spender] * splitMultiplier / SCALE
totalSupply() = rawTotalSupply * splitMultiplier / SCALE
```

Transfers and approvals should accept displayed amounts, convert them to raw amounts, and update raw storage.

A split should update only `splitMultiplier`.

That gives the token the behavior users expect:

- balances split automatically
- allowances split consistently with balances
- transfers after the split move the correct economic amount
- reverse splits are handled without rewriting holder storage
- the implementation remains O(1), no matter how many holders exist

The main design decision is how to handle rounding and dust. For a financial RWA, exact conversion plus an explicit dust policy is usually the cleanest model.
