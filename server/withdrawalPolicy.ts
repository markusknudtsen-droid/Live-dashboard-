/**
 * Withdrawal destination policy.
 *
 * The hot wallet holding trading funds is only as contained as the set of
 * places its funds can leave to. When WITHDRAWAL_ADDRESS is configured, this
 * pins withdrawals to that single operator-controlled address, so reaching the
 * dashboard and knowing the confirmation code is no longer enough to move funds
 * somewhere new — changing the destination requires editing the server's .env.
 */

/**
 * Returns an error message when the destination is not permitted, or null when
 * the withdrawal may proceed.
 *
 * The caller normalises the destination through `PublicKey` first, so this is an
 * exact string comparison rather than a case-insensitive one: base58 is
 * case-sensitive, and two differently-cased strings are two different addresses.
 */
export function checkWithdrawalDestination(
  destinationAddress: string,
  allowlistAddress: string
): string | null {
  const allowlist = allowlistAddress.trim();

  // No allowlist configured: preserve the previous behaviour of accepting any
  // valid address, so existing deployments keep working after an upgrade.
  if (allowlist.length === 0) return null;

  if (destinationAddress !== allowlist) {
    return (
      "Withdrawals are locked to the address configured in WITHDRAWAL_ADDRESS. " +
      "To send somewhere else, change WITHDRAWAL_ADDRESS in the server .env and restart."
    );
  }

  return null;
}
