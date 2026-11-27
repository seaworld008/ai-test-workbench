package com.demo.service.impl;

import com.demo.feign.PayFeignClient;
import com.demo.mapper.OrderMapper;
import com.demo.service.OrderService;

@Service
public class OrderServiceImpl implements OrderService {
    private final OrderMapper orderMapper;
    private final PayFeignClient payFeignClient;

    public OrderServiceImpl(OrderMapper orderMapper, PayFeignClient payFeignClient) {
        this.orderMapper = orderMapper;
        this.payFeignClient = payFeignClient;
    }

    @Override
    public String createOrder(String orderNo) {
        orderMapper.insertOrder(orderNo);
        return payFeignClient.createPayment(orderNo);
    }
}
