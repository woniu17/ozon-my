# -*- coding: utf-8 -*-
from aop.api.base import BaseApi

class FenxiaoSupplyDeleteMonitorProductParam(BaseApi):
    """分销换供删除商品监控，支持删除整个商品或者sku纬度删除监控


    """

    def __init__(self, domain=None):
        BaseApi.__init__(self, domain)
        self.access_token = None
        self.deleteRequest = None

    def get_api_uri(self):
        return '1/com.alibaba.fenxiao/fenxiao.supply.deleteMonitorProduct'

    def get_required_params(self):
        return ['deleteRequest']

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
