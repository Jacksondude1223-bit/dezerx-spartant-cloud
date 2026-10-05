<?php
declare(strict_types=1);

final class SpartanCloudProvisioner
{
    public function __construct(private string $endpoint, private string $secret)
    {
        if (parse_url($endpoint, PHP_URL_SCHEME) !== 'https' || strlen($secret) < 32) {
            throw new InvalidArgumentException('invalid_configuration');
        }
    }

    public function provision(string $paidServiceId, string $customerId, string $primary = 'us'): array
    {
        if (!in_array($primary, ['us', 'de'], true)) {
            throw new InvalidArgumentException('invalid_region');
        }
        return $this->request('POST', '/v1/instances', json_encode(['serviceId' => $paidServiceId, 'customerId' => $customerId, 'primary' => $primary], JSON_THROW_ON_ERROR));
    }

    public function status(string $id): array
    {
        if (!preg_match('/^t-[a-f0-9]{24}$/', $id)) {
            throw new InvalidArgumentException('invalid_id');
        }
        return $this->request('GET', '/v1/instances/'.$id, '');
    }

    public function domain(string $id, string $hostname, string $action = 'reserve'): array
    {
        if (!preg_match('/^t-[a-f0-9]{24}$/', $id) || !in_array($action, ['reserve', 'verify', 'status', 'delete'], true)) {
            throw new InvalidArgumentException('invalid_domain_request');
        }
        return $this->request('POST', '/v1/instances/'.$id.'/domains/'.$action, json_encode(['hostname' => $hostname], JSON_THROW_ON_ERROR));
    }

    private function request(string $method, string $path, string $body): array
    {
        $timestamp = (string) (int) floor(microtime(true) * 1000);
        $signature = hash_hmac('sha256', $timestamp."\n".$method."\n".$path."\n".$body, $this->secret);
        $handle = curl_init(rtrim($this->endpoint, '/').$path);
        curl_setopt_array($handle, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30, CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-Spartan-Timestamp: '.$timestamp, 'X-Spartan-Signature: '.$signature]]);
        if ($method === 'POST') {
            curl_setopt($handle, CURLOPT_POSTFIELDS, $body);
        }
        $result = curl_exec($handle);
        $status = curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);
        if ($result === false || $status < 200 || $status >= 300) {
            throw new RuntimeException('provisioning_request_failed_'.$status);
        }
        return json_decode($result, true, 512, JSON_THROW_ON_ERROR);
    }
}
