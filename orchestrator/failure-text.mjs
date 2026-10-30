// A failure in words a model or an owner may read: our own codes and the SKUs in the owner's table.
// A seller chooses the keys it invents and it has just been refused, so nothing it wrote gets through.
const MAX_NAMED = 50;

export const failureText = (failures, ownerKeys) =>
  failures
    .map(({code, skus}) => {
      const named = skus.filter((sku) => ownerKeys.has(sku)).slice(0, MAX_NAMED);
      return named.length > 0 ? `${code} (${named.join(', ')})` : code;
    })
    .join('; ');
