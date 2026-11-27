package com.demo.controller;

import com.demo.service.OrderService;

@RestController
@RequestMapping("/admin-api/order")
public class OrderController {
    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @PostMapping("/create")
    public String createOrder(String orderNo) {
        return orderService.createOrder(orderNo);
    }
}
