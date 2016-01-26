$(document).ready(function () {
    $('#generateBtn').on('click', function (e) {
        var type = $('#type').val();
        var title = $('#title').val();
        var message = $('#message').val();
        var dismissable = $('#dismissable').is(':checked') ? "true" : "";
        $.ajax({
            url: "div/uuf.template.alert",
            method: "GET",
            data: {type: type, title: title, message: message, dismissable: dismissable},
            success: function (result, status, xhr) {
                $("#alertWrapper").html(result);
            },
            error: function (xhr, status, error) {
                console.log(error);
            }
        });
    })
});
