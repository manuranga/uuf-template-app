function onSuccess(loginInfo){
    var log = new Log("login");
    log.info("User login success '" + stringify(loginInfo.user) + "'.");
}

function onFail(error){
    var log = new Log("login");
    log.info("User login failed '" + error + "'.");
}
