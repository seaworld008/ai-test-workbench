export function createOrder(orderNo) {
  return fetch('/admin-api/order/create', {
    method: 'POST',
    body: JSON.stringify({ orderNo }),
  });
}
