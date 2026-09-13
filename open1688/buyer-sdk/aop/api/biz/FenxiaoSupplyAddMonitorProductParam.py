# -*- coding: utf-8 -*-
from aop.api.base import BaseApi

class FenxiaoSupplyAddMonitorProductParam(BaseApi):
    """分销换供添加商品监控，添加商品可以支持换供结果通知


    """

    def __init__(self, domain=None):
        BaseApi.__init__(self, domain)
        self.access_token = None
        self.addRequest = None

    def get_api_uri(self):
        return '1/com.alibaba.fenxiao/fenxiao.supply.addMonitorProduct'

    def get_required_params(self):
        return ['addRequest']

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
