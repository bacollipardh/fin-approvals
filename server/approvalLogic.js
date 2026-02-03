export function requiredRoleForAmount(amount) {
  if (amount <= 99) return "team_lead";
  if (amount <= 199) return "division_manager";
  return "sales_director";
}
