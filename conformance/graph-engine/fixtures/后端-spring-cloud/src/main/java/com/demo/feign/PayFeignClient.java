package com.demo.feign;

@FeignClient(name = "pay-service", path = "/rpc-api/pay")
public interface PayFeignClient {
    @PostMapping("/create")
    String createPayment(String orderNo);
}
