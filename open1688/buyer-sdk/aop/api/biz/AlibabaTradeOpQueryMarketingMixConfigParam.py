# -*- coding: utf-8 -*-
from aop.api.base import BaseApi

class AlibabaTradeOpQueryMarketingMixConfigParam(BaseApi):
    """查询卖家混批设置。Query seller settings for mixed batch.

    References
    ----------
    https://open.1688.com/api/api.htm?ns=com.alibaba.trade&n=alibaba.trade.OpQueryMarketingMixConfig&v=1&cat=order_category

    """

    def __init__(self, domain=None):
        BaseApi.__init__(self, domain)
        self.access_token = None
        self.sellerMemberId = None
        self.sellerLoginId = None

    def get_api_uri(self):
        return '1/com.alibaba.trade/alibaba.trade.OpQueryMarketingMixConfig'

    def get_required_params(self):
        return ['sellerMemberId', 'sellerLoginId']

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
