# -*- coding: utf-8 -*-
from aop.api.base import BaseApi

class RepurchaseContractGetParam(BaseApi):
    """查询商品是否支持复购合约，复购合约是买卖家签署的复购优惠合约，卖家会给与复购用户特殊的价格、保障。复购合约需要通过特定的交易flow进行下单。

    References
    ----------
    https://open.1688.com/api/api.htm?ns=com.alibaba.trade&n=repurchase.contract.get&v=1&cat=trade

    """

    def __init__(self, domain=None):
        BaseApi.__init__(self, domain)
        self.access_token = None
        self.param = None

    def get_api_uri(self):
        return '1/com.alibaba.trade/repurchase.contract.get'

    def get_required_params(self):
        return ['param']

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
