<template>
  <section class="order-list">
    <button @click="submitOrder">提交订单</button>
  </section>
</template>

<script>
import { createOrder } from '../../api/order.js';

export default {
  name: 'OrderList',
  methods: {
    submitOrder() {
      return createOrder('ORD-001');
    },
  },
};
</script>
