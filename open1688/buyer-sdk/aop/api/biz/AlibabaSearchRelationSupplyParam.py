# -*- coding: utf-8 -*-
from aop.api.base import BaseApi

class AlibabaSearchRelationSupplyParam(BaseApi):
    """推荐搜索跟采购商有关的供应商列表，比如查看该买家有过交易记录的卖家，或者关注过的卖家等。该接口需要像开放平台申请权限才能访问

    References
    ----------
    https://open.1688.com/api/api.htm?ns=com.alibaba.search&n=alibaba.search.relation.supply&v=1&cat=account_search

    """

    def __init__(self, domain=None):
        BaseApi.__init__(self, domain)
        self.access_token = None
        self.relationTime = None
        self.pageNum = None
        self.pageSize = None
        self.sellerLoginId = None

    def get_api_uri(self):
        return '1/com.alibaba.search/alibaba.search.relation.supply'

    def get_required_params(self):
        return ['relationTime', 'pageNum', 'pageSize', 'sellerLoginId']

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
