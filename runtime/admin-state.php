<?php
declare(strict_types=1);
try {
    $input = json_decode(stream_get_contents(STDIN), true, 16, JSON_THROW_ON_ERROR);
    require '/var/www/html/vendor/autoload.php';
    $app = require '/var/www/html/bootstrap/app.php';
    $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
    $provider = config('auth.guards.'.config('auth.defaults.guard').'.provider', 'users');
    $model = config('auth.providers.'.$provider.'.model');
    if (!is_string($model) || !is_subclass_of($model, Illuminate\Database\Eloquent\Model::class)) {
        exit(20);
    }
    $query = (new $model)->newQuery();
    $count = $query->count();
    if ($count === 0) {
        exit(0);
    }
    if ($count !== 1) {
        exit(20);
    }
    $user = (new $model)->newQuery()->where('email', $input['email'])->first();
    if (!$user || !Illuminate\Support\Facades\Hash::check($input['password'], $user->getAuthPassword())) {
        exit(20);
    }
    $role = $user->getAttribute('role');
    if ($role instanceof BackedEnum) {
        $role = $role->value;
    }
    $superadmin = $role === 'superadmin' || (method_exists($user, 'hasRole') && $user->hasRole('superadmin'));
    exit($superadmin ? 10 : 20);
} catch (Throwable $error) {
    exit(20);
}
