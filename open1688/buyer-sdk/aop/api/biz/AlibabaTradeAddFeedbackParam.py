# -*- coding: utf-8 -*-
from aop.api.base import BaseApi

class AlibabaTradeAddFeedbackParam(BaseApi):
    """买家补充订单留言接口，注意留言总长不超500字符

    References
    ----------
    https://open.1688.com/api/api.htm?ns=com.alibaba.trade&n=alibaba.trade.addFeedback&v=1&cat=aop.trade

    """

    def __init__(self, domain=None):
        BaseApi.__init__(self, domain)
        self.access_token = None
        self.tradeFeedbackParam = None

    def get_api_uri(self):
        return '1/com.alibaba.trade/alibaba.trade.addFeedback'

    def get_required_params(self):
        return ['tradeFeedbackParam']

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
