/**
 * Fund companies are not `Institution` rows — they are names resolved from
 * `FundProfile.fundCompany`. The institution scope filter hosts them as an extra
 * group by carrying them inside `institutionIds` under this prefix.
 *
 * These helpers are plain functions used by both server and client code, so they
 * must NOT live in a `"use client"` module (a server component cannot invoke a
 * client function).
 */

export const FUND_COMPANY_INSTITUTION_PREFIX = "__fundcompany__:";

export function fundCompanyInstitutionId(name: string) {
  return `${FUND_COMPANY_INSTITUTION_PREFIX}${name}`;
}

export function parseFundCompanyInstitutionId(id: string) {
  return id.startsWith(FUND_COMPANY_INSTITUTION_PREFIX) ? id.slice(FUND_COMPANY_INSTITUTION_PREFIX.length) : null;
}

/** Split an institution selection into real institution ids and fund company names. */
export function splitInstitutionSelection(institutionIds: string[]) {
  const fundCompanies: string[] = [];
  const institutionIdsOnly: string[] = [];
  for (const id of institutionIds) {
    const company = parseFundCompanyInstitutionId(id);
    if (company) fundCompanies.push(company);
    else institutionIdsOnly.push(id);
  }
  return { fundCompanies, institutionIds: institutionIdsOnly };
}
