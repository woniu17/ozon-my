# -*- coding: utf-8 -*-
from aop.api.base import BaseApi

class AlibabaProductSimpleGetParam(BaseApi):
    """由商品ID获取商品详细信息，接口能获取已购买过商家的商品简单信息。该接口需要付费才能访问。该接口只返回简单信息，主要是用来在ERP系统中做数据关联

    References
    ----------
    https://open.1688.com/api/api.htm?ns=com.alibaba.product&n=alibaba.product.simple.get&v=1&cat=product

    """

    def __init__(self, domain=None):
        BaseApi.__init__(self, domain)
        self.access_token = None
        self.productID = None
        self.webSite = None

    def get_api_uri(self):
        return '1/com.alibaba.product/alibaba.product.simple.get'

    def get_required_params(self):
        return ['productID', 'webSite']

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
