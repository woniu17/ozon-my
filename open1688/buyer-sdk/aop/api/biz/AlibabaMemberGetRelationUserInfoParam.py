# -*- coding: utf-8 -*-
from aop.api.base import BaseApi

class AlibabaMemberGetRelationUserInfoParam(BaseApi):
    """根据旺铺域名获取已购买过的商家信息


    References
    ----------
    https://open.1688.com/api/api.htm?ns=com.alibaba.trade&n=alibaba.member.getRelationUserInfo&v=1&cat=trade

    """

    def __init__(self, domain=None):
        BaseApi.__init__(self, domain)
        self.access_token = None
        self.domain = None

    def get_api_uri(self):
        return '1/com.alibaba.trade/alibaba.member.getRelationUserInfo'

    def get_required_params(self):
        return ['domain']

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
