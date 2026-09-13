# -*- coding: utf-8 -*-
from aop.api.base import BaseApi

class AlibabaAlipayUrlGetParam(BaseApi):
    """通过ERP付款时，可以通过本API获取批量支付的收银台的链接。
单个订单返回1688收银台地址，多个订单返回支付宝收银台地址。
ERP可以引导用户跳转到收银台链接完成支付动作，支付前会校验用户在1688的登陆状态。


    References
    ----------
    https://open.1688.com/api/api.htm?ns=com.alibaba.trade&n=alibaba.alipay.url.get&v=1&cat=payment

    """

    def __init__(self, domain=None):
        BaseApi.__init__(self, domain)
        self.access_token = None
        self.orderIdList = None

    def get_api_uri(self):
        return '1/com.alibaba.trade/alibaba.alipay.url.get'

    def get_required_params(self):
        return ['orderIdList']

    def get_multipart_params(self):
        return []

    def need_sign(self):
        return True

    def need_timestamp(self):
        return False

    def need_auth(self):
        return True

    def need_https(self):
        return False

    def is_inner_api(self):
        return False
