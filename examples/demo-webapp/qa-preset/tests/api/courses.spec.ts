import { test, expect, expectApiContract } from '../fixtures/base';

interface CourseItem {
  id: string;
  title: string;
  seatsLeft: number;
}

interface CoursesResponse {
  courses: CourseItem[];
}

test.describe('Smart Campus Courses & Enrollment API Contracts', () => {
  test('GET /api/courses matches contract and includes boundary seat items @critical', async ({ request }) => {
    const response = await request.get('/api/courses');
    const data = await expectApiContract<CoursesResponse>(response, 200, (body) => {
      expect(Array.isArray(body.courses)).toBe(true);
      expect(body.courses.length).toBeGreaterThanOrEqual(3);
      for (const course of body.courses) {
        expect(typeof course.id).toBe('string');
        expect(typeof course.title).toBe('string');
        expect(typeof course.seatsLeft).toBe('number');
      }
    });

    const soldOut = data.courses.find((c) => c.seatsLeft === 0);
    expect(soldOut).toBeDefined();
  });

  test('GET /api/admin/audit enforces 403 RBAC for student token @critical', async ({ request }) => {
    const loginRes = await request.post('/api/login', {
      data: { username: 'student_rbac_check', password: 'qa-pass-123' },
    });
    const { token } = (await expectApiContract<{ token: string }>(loginRes, 200)) as { token: string };

    const adminRes = await request.get('/api/admin/audit', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(adminRes.status()).toBe(403);
  });

  test('duplicate enrollment returns 409 and concurrent 1-seat race yields exact 201 + 409 @mutation', async ({
    request,
  }, testInfo) => {
    const resetRes = await request.post('/__test__/reset');
    expect(resetRes.status()).toBe(200);

    const workerTag = `w${testInfo.workerIndex}_${Date.now()}`;
    const userA = `student_${workerTag}_a`;
    const userB = `student_${workerTag}_b`;

    const loginA = await request.post('/api/login', { data: { username: userA, password: 'qa-pass-123' } });
    const loginB = await request.post('/api/login', { data: { username: userB, password: 'qa-pass-123' } });
    const { token: tokenA } = await loginA.json();
    const { token: tokenB } = await loginB.json();

    const firstEnroll = await request.post('/api/enroll', {
      headers: { Authorization: `Bearer ${tokenA}` },
      data: { courseId: 'course-open-101' },
    });
    expect(firstEnroll.status()).toBe(201);

    const duplicateEnroll = await request.post('/api/enroll', {
      headers: { Authorization: `Bearer ${tokenA}` },
      data: { courseId: 'course-open-101' },
    });
    expect(duplicateEnroll.status()).toBe(409);

    const [race1, race2] = await Promise.all([
      request.post('/api/enroll', {
        headers: { Authorization: `Bearer ${tokenA}` },
        data: { courseId: 'course-last-seat' },
      }),
      request.post('/api/enroll', {
        headers: { Authorization: `Bearer ${tokenB}` },
        data: { courseId: 'course-last-seat' },
      }),
    ]);

    const statuses = [race1.status(), race2.status()].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
  });
});
