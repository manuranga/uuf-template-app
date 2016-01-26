function onRequest(context) {
    context.handlebars.registerHelper('json', function(obj) {
        new Log().warn("===================="+JSON.stringify(obj));
        return (JSON.stringify(obj));
    });
}